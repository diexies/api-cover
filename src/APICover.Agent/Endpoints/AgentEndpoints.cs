using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using APICover.Agent.Anthropic;
using APICover.Agent.Credentials;
using APICover.Agent.Engine;
using APICover.Agent.Memory;
using APICover.Agent.Sessions;

namespace APICover.Agent.Endpoints;

/// <summary>
/// Agent HTTP endpoints mounted under <c>{prefix}/api/agent/*</c>. The discovery /options
/// endpoint exposes <c>agentAvailable: true</c> when this routing layer is present, so the
/// UI can hide its own controls when the package isn't loaded.
/// </summary>
public static class AgentEndpoints
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) }
    };

    public static void MapAgent(IEndpointRouteBuilder endpoints, string prefix)
    {
        var agent = endpoints.MapGroup($"{prefix}/api/agent");
        agent.ExcludeFromDescription();

        agent.MapGet("/status", async (
            IOptions<AgentOptions> opts,
            MaxSubscriptionProbe probe,
            IAgentCredentialStore store,
            IAgentMemoryStore memory,
            MemoryBootstrap bootstrap) =>
        {
            await bootstrap.EnsureAsync();
            return HandleStatus(opts, probe, store, memory);
        });

        agent.MapGet("/credentials", async (IAgentCredentialStore store, MaxSubscriptionProbe probe) =>
        {
            var stored = await store.GetAsync();
            var probeResult = probe.Probe();
            return Results.Json(new
            {
                mode = stored?.Mode.ToString() ?? "Disabled",
                hasApiKey = !string.IsNullOrEmpty(stored?.EncryptedApiKey),
                lastFourChars = stored?.LastFourChars,
                dailyDollarCap = stored?.DailyDollarCap,
                maxDetected = probeResult.Available,
                maxVersion = probeResult.Version,
                maxError = probeResult.Error
            }, Json);
        });

        agent.MapPut("/credentials", async (
            HttpRequest request,
            IAgentCredentialStore store,
            CredentialEncryption encryption,
            IOptions<AgentOptions> opts) =>
        {
            using var doc = await JsonDocument.ParseAsync(request.Body);
            var root = doc.RootElement;
            var modeStr = root.TryGetProperty("mode", out var mEl) && mEl.ValueKind == JsonValueKind.String
                ? mEl.GetString() : null;
            if (!Enum.TryParse<AgentCredentialMode>(modeStr, ignoreCase: true, out var mode))
            {
                return Results.BadRequest(new { error = "Invalid 'mode'. Expected one of Disabled / ApiKey / Max." });
            }

            if (mode == AgentCredentialMode.Max && !opts.Value.AllowMaxSubscription)
            {
                return Results.BadRequest(new { error = "Max subscription mode is disabled by AgentOptions." });
            }
            if (mode == AgentCredentialMode.ApiKey && !opts.Value.AllowApiKey)
            {
                return Results.BadRequest(new { error = "API-key mode is disabled by AgentOptions." });
            }

            string? apiKey = null;
            decimal? cap = null;
            if (mode == AgentCredentialMode.ApiKey)
            {
                apiKey = root.TryGetProperty("apiKey", out var keyEl) && keyEl.ValueKind == JsonValueKind.String
                    ? keyEl.GetString() : null;
                if (string.IsNullOrEmpty(apiKey))
                {
                    return Results.BadRequest(new { error = "Field 'apiKey' is required when mode=ApiKey." });
                }
                if (root.TryGetProperty("dailyDollarCap", out var capEl) && capEl.ValueKind == JsonValueKind.Number)
                {
                    cap = capEl.GetDecimal();
                }
                if (cap is null || cap <= 0)
                {
                    return Results.BadRequest(new { error = "Field 'dailyDollarCap' is required (positive number) when mode=ApiKey." });
                }
            }

            var record = new StoredCredential(
                Mode: mode,
                EncryptedApiKey: apiKey is null ? null : encryption.Protect(apiKey),
                LastFourChars: apiKey is null ? null : CredentialEncryption.LastFour(apiKey),
                DailyDollarCap: cap,
                UpdatedAt: DateTimeOffset.UtcNow);

            await store.SaveAsync(record);
            return Results.Json(new { ok = true, mode = mode.ToString() }, Json);
        });

        agent.MapDelete("/credentials", async (IAgentCredentialStore store) =>
        {
            await store.DeleteAsync();
            return Results.NoContent();
        });

        agent.MapPost("/credentials/test", async (
            IClaudeCredentialProvider provider,
            IAnthropicClient client,
            IOptions<AgentOptions> opts) =>
        {
            try
            {
                var credential = await provider.GetAsync(default);
                _ = credential;
                var ping = new MessageRequest
                {
                    Model = opts.Value.Model,
                    MaxTokens = 16,
                    Messages = new[]
                    {
                        new Message { Role = "user", Content = new[] { ContentBlock.TextBlock("ping") } }
                    }
                };
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
                var response = await client.SendAsync(ping, cts.Token);
                _ = response;
                return Results.Json(new { ok = true }, Json);
            }
            catch (Exception ex)
            {
                return Results.Json(new { ok = false, error = ex.Message }, Json, statusCode: 200);
            }
        });

        // Snapshot of in-flight runs. Used by the UI to detect that a scan started
        // before a page refresh is still running, so the memory tab can keep the
        // "Scanning…" affordance instead of inviting a duplicate scan.
        agent.MapGet("/runs/active", (IAgentRunStore store) =>
        {
            var active = store.List(50)
                .Where(r => r.Status == AgentRunStatus.Running)
                .Select(r => new
                {
                    runId = r.Id,
                    mode = r.Mode,
                    startedAt = r.StartedAt,
                    prompt = r.Prompt,
                })
                .ToArray();
            return Results.Json(new { count = active.Length, runs = active }, Json);
        });

        agent.MapPost("/runs", async (HttpRequest request, AgentRunCoordinator coordinator) =>
        {
            using var doc = await JsonDocument.ParseAsync(request.Body);
            var root = doc.RootElement;
            var prompt = root.TryGetProperty("prompt", out var pEl) && pEl.ValueKind == JsonValueKind.String
                ? pEl.GetString() : null;
            var modeStr = root.TryGetProperty("mode", out var mEl) && mEl.ValueKind == JsonValueKind.String
                ? mEl.GetString() : "chat";
            if (!Enum.TryParse<AgentRunMode>(modeStr, ignoreCase: true, out var mode))
            {
                mode = AgentRunMode.Chat;
            }
            if (string.IsNullOrWhiteSpace(prompt))
            {
                if (mode == AgentRunMode.Scan)
                {
                    prompt = "Run a project scan and populate memory per the operating manual.";
                }
                else
                {
                    return Results.BadRequest(new { error = "Field 'prompt' is required." });
                }
            }

            var result = coordinator.Start(prompt, mode);
            if (!result.Started)
            {
                return Results.Json(new { error = result.RejectionReason }, Json, statusCode: 429);
            }
            return Results.Json(new { runId = result.RunId, mode = mode.ToString() }, Json);
        });

        var memoryGroup = agent.MapGroup("/memory");

        memoryGroup.MapGet("/", async (IAgentMemoryStore memory) =>
        {
            var entries = await memory.ListAsync();
            return Results.Json(new
            {
                root = memory.RootPath,
                count = entries.Count,
                files = entries
            }, Json);
        });

        memoryGroup.MapGet("/file", async (string path, IAgentMemoryStore memory) =>
        {
            try
            {
                var content = await memory.ReadAsync(path);
                return content is null
                    ? Results.NotFound(new { error = $"No memory file at '{path}'." })
                    : Results.Json(new { path, content }, Json);
            }
            catch (ArgumentException ex)
            {
                return Results.BadRequest(new { error = ex.Message });
            }
        });

        memoryGroup.MapPut("/file", async (HttpRequest request, IAgentMemoryStore memory) =>
        {
            using var doc = await JsonDocument.ParseAsync(request.Body);
            var path = doc.RootElement.TryGetProperty("path", out var pEl) && pEl.ValueKind == JsonValueKind.String
                ? pEl.GetString() : null;
            var content = doc.RootElement.TryGetProperty("content", out var cEl) && cEl.ValueKind == JsonValueKind.String
                ? cEl.GetString() : null;
            if (string.IsNullOrEmpty(path) || content is null)
            {
                return Results.BadRequest(new { error = "Required fields: path, content." });
            }
            try
            {
                await memory.WriteAsync(path, content);
                return Results.Json(new { ok = true, path }, Json);
            }
            catch (ArgumentException ex)
            {
                return Results.BadRequest(new { error = ex.Message });
            }
            catch (InvalidOperationException ex)
            {
                return Results.Problem(ex.Message, statusCode: 413);
            }
        });

        memoryGroup.MapDelete("/file", async (string path, IAgentMemoryStore memory) =>
        {
            try
            {
                await memory.DeleteAsync(path);
                return Results.NoContent();
            }
            catch (ArgumentException ex)
            {
                return Results.BadRequest(new { error = ex.Message });
            }
        });

        var sessionsGroup = agent.MapGroup("/sessions");

        sessionsGroup.MapGet("/", async (int? take, IAgentSessionStore sessions) =>
        {
            var summaries = await sessions.ListAsync(take ?? 50);
            return Results.Json(new
            {
                root = sessions.RootPath,
                count = summaries.Count,
                sessions = summaries
            }, Json);
        });

        sessionsGroup.MapGet("/{id}", async (string id, IAgentSessionStore sessions) =>
        {
            try
            {
                var doc = await sessions.GetAsync(id);
                return doc is null ? Results.NotFound() : Results.Json(doc, Json);
            }
            catch (ArgumentException ex)
            {
                return Results.BadRequest(new { error = ex.Message });
            }
        });

        sessionsGroup.MapDelete("/{id}", async (string id, IAgentSessionStore sessions) =>
        {
            try
            {
                await sessions.DeleteAsync(id);
                return Results.NoContent();
            }
            catch (ArgumentException ex)
            {
                return Results.BadRequest(new { error = ex.Message });
            }
        });

        agent.MapGet("/runs/{id}/events", AgentEventStreamHandler);

        agent.MapGet("/runs", (IAgentRunStore store) => Results.Json(store.List(), Json));

        agent.MapGet("/runs/{id}", (string id, IAgentRunStore store) =>
        {
            var record = store.Get(id);
            return record is null ? Results.NotFound() : Results.Json(record, Json);
        });
    }

    private static IResult HandleStatus(
        IOptions<AgentOptions> opts,
        MaxSubscriptionProbe probe,
        IAgentCredentialStore store,
        IAgentMemoryStore memory)
    {
        var probeResult = probe.Probe();
        var stored = store.GetAsync().GetAwaiter().GetResult();
        var entries = memory.ListAsync().GetAwaiter().GetResult();
        var memoryFileCount = entries.Count;
        var nonBootstrapCount = entries.Count(e => e.Path is not "introduce.md" and not "index.md");
        return Results.Json(new
        {
            available = true,
            model = opts.Value.Model,
            allowApiKey = opts.Value.AllowApiKey,
            allowMaxSubscription = opts.Value.AllowMaxSubscription,
            maxDetected = probeResult.Available,
            maxVersion = probeResult.Version,
            mode = stored?.Mode.ToString() ?? "Disabled",
            hasApiKey = !string.IsNullOrEmpty(stored?.EncryptedApiKey),
            dailyDollarCap = stored?.DailyDollarCap,
            globalDailyDollarCap = opts.Value.MaxDollarsPerDay,
            maxTokensPerRun = opts.Value.MaxTokensPerRun,
            maxToolCallsPerRun = opts.Value.MaxToolCallsPerRun,
            memoryRoot = memory.RootPath,
            memoryFileCount,
            memoryEmpty = nonBootstrapCount == 0
        }, Json);
    }

    private static async Task AgentEventStreamHandler(string id, HttpContext ctx, AgentRunCoordinator coordinator, IAgentRunStore store)
    {
        var record = store.Get(id);
        if (record is null)
        {
            ctx.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }

        ctx.Response.Headers.ContentType = "text/event-stream";
        ctx.Response.Headers.CacheControl = "no-cache";
        ctx.Response.Headers["X-Accel-Buffering"] = "no";

        try
        {
            await foreach (var evt in coordinator.Subscribe(id, ctx.RequestAborted))
            {
                var name = evt.Type.ToString();
                var payload = JsonSerializer.Serialize(evt, Json);
                await WriteEvent(ctx, name, payload);
                if (evt.Type is AgentEventType.RunCompleted or AgentEventType.RunFailed or AgentEventType.BudgetExhausted)
                {
                    break;
                }
            }
        }
        catch (OperationCanceledException) { }
    }

    private static async Task WriteEvent(HttpContext ctx, string name, string data)
    {
        await ctx.Response.WriteAsync($"event: {name}\n");
        foreach (var line in data.Split('\n'))
        {
            await ctx.Response.WriteAsync($"data: {line}\n");
        }
        await ctx.Response.WriteAsync("\n");
        await ctx.Response.Body.FlushAsync();
    }
}
