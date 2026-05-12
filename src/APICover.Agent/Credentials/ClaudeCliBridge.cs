using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using APICover.Agent.Anthropic;

namespace APICover.Agent.Credentials;

/// <summary>
/// Max-subscription path. Spawns the <c>claude</c> CLI as a child process, pipes a single
/// prompt, parses the response, returns it shaped as a Messages-API <see cref="MessageResponse"/>.
/// EXPERIMENTAL — depends on the CLI's print-mode JSON output staying stable. We pin to
/// <c>--output-format json</c> and wrap the lone assistant message in our DTO.
///
/// Tool-use is NOT supported via this bridge in M1 — the CLI's tool harness is its own
/// thing and doesn't accept arbitrary external tool definitions cleanly. When a Max-mode
/// run requests tools, the bridge returns a single text block apologising and instructing
/// the caller to use API-key mode for tool-augmented runs. The agent engine surfaces this
/// via <c>RunFailed</c>.
/// </summary>
internal sealed class ClaudeCliBridge : IAnthropicClient
{
    private readonly IClaudeCredentialProvider _credentials;
    private readonly IOptions<AgentOptions> _options;
    private readonly IHostEnvironment _env;
    private readonly IServer _server;

    public ClaudeCliBridge(IClaudeCredentialProvider credentials, IOptions<AgentOptions> options, IHostEnvironment env, IServer server)
    {
        _credentials = credentials;
        _options = options;
        _env = env;
        _server = server;
    }

    public async Task<MessageResponse> SendAsync(MessageRequest request, CancellationToken cancellationToken)
    {
        var credential = await _credentials.GetAsync(cancellationToken);
        if (credential is not MaxSubscriptionCredential max)
        {
            throw new InvalidOperationException("ClaudeCliBridge requires a Max-subscription credential.");
        }

        // We don't translate the agent's tool definitions to the CLI — the CLI has
        // its own native tool harness (Read/Write/Bash/Grep/Glob). Instead, when the
        // agent loop signals it wants tool execution (any non-empty Tools list), we
        // hand the CLI permission to use its built-ins inside the project root and
        // let it walk the codebase + write memory files itself. The agent loop sees
        // a single text turn with the CLI's final summary and ends.
        var prompt = BuildPromptText(request);
        var wantsTools = request.Tools is { Count: > 0 };
        var workDir = _env.ContentRootPath;

        var psi = new ProcessStartInfo
        {
            FileName = max.CliPath,
            WorkingDirectory = workDir,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        psi.ArgumentList.Add("--print");
        psi.ArgumentList.Add("--output-format");
        psi.ArgumentList.Add("json");

        // MCP self-loopback: feed the CLI the in-process APICover MCP server so it can
        // call scenarios.save, endpoints.list, etc. Wired only when the run wants tools
        // AND we know our own listening URL. Falls back silently to "tools disabled" if
        // the server addresses feature is not yet populated (very early startup).
        string? mcpConfigPath = null;
        var mcpUrl = TryResolveMcpUrl();
        if (wantsTools && mcpUrl is not null)
        {
            mcpConfigPath = WriteMcpConfig(mcpUrl);
            psi.ArgumentList.Add("--mcp-config");
            psi.ArgumentList.Add(mcpConfigPath);
            psi.ArgumentList.Add("--strict-mcp-config");
        }

        if (wantsTools)
        {
            // Allow the CLI's built-in tools so it can actually do scan / scenario
            // work. acceptEdits skips the per-edit confirmation (we trust the agent
            // since it's running in a known workspace dir). When MCP is wired, also
            // allow every mcp__apicover__* tool by wildcard.
            psi.ArgumentList.Add("--allowed-tools");
            psi.ArgumentList.Add("Read");
            psi.ArgumentList.Add("Write");
            psi.ArgumentList.Add("Edit");
            psi.ArgumentList.Add("Glob");
            psi.ArgumentList.Add("Grep");
            psi.ArgumentList.Add("Bash");
            if (mcpConfigPath is not null)
            {
                psi.ArgumentList.Add("mcp__apicover");
            }
            psi.ArgumentList.Add("--permission-mode");
            psi.ArgumentList.Add("acceptEdits");
            psi.ArgumentList.Add("--add-dir");
            psi.ArgumentList.Add(workDir);
        }
        // Skip --model: AgentOptions.Model holds an Anthropic API id; the CLI rejects
        // those. Use whatever model the user's CLI is configured with.

        using var proc = Process.Start(psi)
            ?? throw new InvalidOperationException("Failed to start claude CLI.");

        await proc.StandardInput.WriteAsync(prompt);
        proc.StandardInput.Close();

        var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutCts.CancelAfter(TimeSpan.FromSeconds(_options.Value.RequestTimeoutSeconds));

        try
        {
            await proc.WaitForExitAsync(timeoutCts.Token);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            try { proc.Kill(true); } catch { }
            throw new TimeoutException("claude CLI timed out.");
        }

        if (proc.ExitCode != 0)
        {
            var stderr = await proc.StandardError.ReadToEndAsync(cancellationToken);
            throw new InvalidOperationException($"claude CLI exited {proc.ExitCode}: {stderr.Trim()}");
        }

        var stdout = await proc.StandardOutput.ReadToEndAsync(cancellationToken);

        if (mcpConfigPath is not null)
        {
            try { File.Delete(mcpConfigPath); } catch { /* best effort */ }
        }

        return ParseCliJson(stdout);
    }

    private string? TryResolveMcpUrl()
    {
        var addresses = _server.Features.Get<IServerAddressesFeature>()?.Addresses;
        if (addresses is null || addresses.Count == 0) return null;
        // Prefer http over https (CLI runs locally, self-signed cert noise). Take the first
        // bindable address; replace 0.0.0.0/[::]/+ with 127.0.0.1 so the subprocess can dial.
        var raw = addresses.FirstOrDefault(a => a.StartsWith("http://"))
            ?? addresses.First();
        var url = raw.Replace("://0.0.0.0", "://127.0.0.1")
                     .Replace("://[::]", "://127.0.0.1")
                     .Replace("://+", "://127.0.0.1");
        return url.TrimEnd('/') + "/apicover/mcp";
    }

    private static string WriteMcpConfig(string mcpUrl)
    {
        var payload = new
        {
            mcpServers = new Dictionary<string, object>
            {
                ["apicover"] = new { type = "http", url = mcpUrl }
            }
        };
        var path = Path.Combine(Path.GetTempPath(), $"apicover-mcp-{Guid.NewGuid():N}.json");
        File.WriteAllText(path, JsonSerializer.Serialize(payload));
        return path;
    }

    private static string BuildPromptText(MessageRequest request)
    {
        var sb = new StringBuilder();
        if (!string.IsNullOrEmpty(request.System))
        {
            sb.AppendLine(request.System);
            sb.AppendLine();
        }
        foreach (var msg in request.Messages)
        {
            foreach (var block in msg.Content)
            {
                if (block.Type == "text" && !string.IsNullOrEmpty(block.Text))
                {
                    sb.AppendLine(block.Text);
                }
            }
        }
        return sb.ToString();
    }

    private static MessageResponse ParseCliJson(string stdout)
    {
        try
        {
            using var doc = JsonDocument.Parse(stdout);
            var root = doc.RootElement;
            // The CLI's --output-format json shape (as of recent versions) yields:
            // { "result": "...assistant text...", "duration_ms": ..., "is_error": false, ... }
            // Tolerate alternative shapes by falling back to raw text.
            var text = root.TryGetProperty("result", out var resultEl) && resultEl.ValueKind == JsonValueKind.String
                ? resultEl.GetString()
                : stdout;
            // CLI returns exit 0 even for some upstream errors (e.g. 404 on bad model). Surface
            // those instead of letting the error message pose as an assistant reply.
            if (root.TryGetProperty("is_error", out var errEl) && errEl.ValueKind == JsonValueKind.True)
            {
                throw new InvalidOperationException($"claude CLI error: {text}");
            }
            var inputTokens = root.TryGetProperty("usage", out var usageEl)
                && usageEl.TryGetProperty("input_tokens", out var inEl) && inEl.TryGetInt32(out var i) ? i : 0;
            var outputTokens = usageEl.ValueKind == JsonValueKind.Object
                && usageEl.TryGetProperty("output_tokens", out var outEl) && outEl.TryGetInt32(out var o) ? o : 0;

            return new MessageResponse
            {
                StopReason = "end_turn",
                Content = new[] { ContentBlock.TextBlock(text ?? string.Empty) },
                Usage = new Usage { InputTokens = inputTokens, OutputTokens = outputTokens }
            };
        }
        catch (JsonException)
        {
            return new MessageResponse
            {
                StopReason = "end_turn",
                Content = new[] { ContentBlock.TextBlock(stdout) }
            };
        }
    }
}
