using System.Diagnostics;
using System.Text;
using System.Text.Json;
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

    public ClaudeCliBridge(IClaudeCredentialProvider credentials, IOptions<AgentOptions> options, IHostEnvironment env)
    {
        _credentials = credentials;
        _options = options;
        _env = env;
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
        if (wantsTools)
        {
            // Allow the CLI's built-in tools so it can actually do scan / scenario
            // work. acceptEdits skips the per-edit confirmation (we trust the agent
            // since it's running in a known workspace dir).
            psi.ArgumentList.Add("--allowed-tools");
            psi.ArgumentList.Add("Read");
            psi.ArgumentList.Add("Write");
            psi.ArgumentList.Add("Edit");
            psi.ArgumentList.Add("Glob");
            psi.ArgumentList.Add("Grep");
            psi.ArgumentList.Add("Bash");
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
        return ParseCliJson(stdout);
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
