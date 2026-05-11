using System.Collections.Concurrent;
using System.Threading.Channels;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using APICover.Agent.Anthropic;
using APICover.Agent.Credentials;
using APICover.Agent.Memory;
using APICover.Agent.Sessions;
using APICover.Agent.Tools;

namespace APICover.Agent.Engine;

public enum AgentRunMode
{
    Chat = 0,
    Scan = 1
}

/// <summary>
/// Outer loop of the agent: builds a Messages-API request, dispatches tool calls when
/// Claude asks for them, accrues budget, emits <see cref="AgentEvent"/> updates over a
/// per-run channel that endpoints stream as SSE.
/// </summary>
public sealed class AgentRunCoordinator
{
    private const string ChatModeTail =
        "## Mode: chat\n\n"
      + "1. Call `list_memory` first.\n"
      + "2. Read every memory file relevant to the user's prompt before reasoning.\n"
      + "3. Answer concisely. Cite memory file paths. Never invent endpoints.\n"
      + "4. If you discover a fact not in memory, append it to the appropriate file before "
      + "ending the turn, with a `<!-- learned -->` provenance comment.\n";

    private const string ScanModeTail =
        "## Mode: scan\n\n"
      + "Build or refresh the project's memory. Procedure:\n"
      + "1. `list_memory` — see what's already there.\n"
      + "2. `list_endpoints` — group by area.\n"
      + "3. For each area, fetch `get_endpoint_details` for every endpoint, then write or "
      + "update the corresponding `controllers/<name>.md`. Identify services/external "
      + "boundaries from descriptors and create `services/<name>.md` / `external/<host>.md` "
      + "files. Identify cross-cutting domain narratives and create `domain/<concept>.md` "
      + "files.\n"
      + "4. Maintain `index.md` after every write — one line per file with a hook explaining "
      + "when to read it.\n"
      + "5. Finalise with `project.md` (project kind, primary domains, auth style, observed "
      + "patterns, current ISO timestamp).\n"
      + "6. STOP. Do not produce conversational output — your work is the memory files.\n";

    private readonly IAnthropicClient _anthropic;
    private readonly ToolDispatcher _tools;
    private readonly AgentBudgetTracker _budget;
    private readonly IClaudeCredentialProvider _credentials;
    private readonly IAgentRunStore _store;
    private readonly IAgentSessionStore _sessions;
    private readonly MemoryBootstrap _memoryBootstrap;
    private readonly IOptions<AgentOptions> _options;
    private readonly ILogger<AgentRunCoordinator> _log;

    private readonly ConcurrentDictionary<string, Channel<AgentEvent>> _channels = new();

    public AgentRunCoordinator(
        IAnthropicClient anthropic,
        ToolDispatcher tools,
        AgentBudgetTracker budget,
        IClaudeCredentialProvider credentials,
        IAgentRunStore store,
        IAgentSessionStore sessions,
        MemoryBootstrap memoryBootstrap,
        IOptions<AgentOptions> options,
        ILogger<AgentRunCoordinator> log)
    {
        _anthropic = anthropic;
        _tools = tools;
        _budget = budget;
        _credentials = credentials;
        _store = store;
        _sessions = sessions;
        _memoryBootstrap = memoryBootstrap;
        _options = options;
        _log = log;
    }

    public sealed record StartResult(bool Started, string? RunId, string? RejectionReason);

    public StartResult Start(string prompt, AgentRunMode mode = AgentRunMode.Chat)
    {
        ClaudeCredential credential;
        try
        {
            credential = _credentials.GetAsync(default).GetAwaiter().GetResult();
        }
        catch (Exception ex)
        {
            return new StartResult(false, null, ex.Message);
        }

        var perCredCap = credential is ApiKeyCredential apiKey ? apiKey.DailyDollarCap : null;
        var check = _budget.TryStartRun(perCredCap);
        if (!check.Allowed)
        {
            return new StartResult(false, null, check.Reason);
        }

        var runId = Guid.NewGuid().ToString("N");
        var record = new AgentRunRecord
        {
            Id = runId,
            Prompt = prompt,
            StartedAt = DateTimeOffset.UtcNow,
            Status = AgentRunStatus.Running,
            Mode = mode.ToString().ToLowerInvariant(),
        };
        _store.Save(record);

        var session = new SessionDoc
        {
            Id = runId,
            Prompt = prompt,
            Mode = mode.ToString().ToLowerInvariant(),
            StartedAt = record.StartedAt,
            Status = "running",
            Model = _options.Value.Model
        };

        var channel = Channel.CreateUnbounded<AgentEvent>(new UnboundedChannelOptions
        {
            SingleReader = false,
            SingleWriter = true,
            AllowSynchronousContinuations = false
        });
        _channels[runId] = channel;

        _ = Task.Run(() => RunAsync(runId, prompt, mode, perCredCap, channel.Writer, record, session));
        return new StartResult(true, runId, null);
    }

    public IAsyncEnumerable<AgentEvent> Subscribe(string runId, CancellationToken cancellationToken)
    {
        if (!_channels.TryGetValue(runId, out var channel))
        {
            return EmptyAsync<AgentEvent>();
        }
        return channel.Reader.ReadAllAsync(cancellationToken);
    }

    private async Task RunAsync(
        string runId,
        string prompt,
        AgentRunMode mode,
        decimal? perCredCap,
        ChannelWriter<AgentEvent> writer,
        AgentRunRecord record,
        SessionDoc session)
    {
        try
        {
            await EmitAsync(writer, session, new AgentEvent { Type = AgentEventType.RunStarted, RunId = runId });

            var systemPrompt = await BuildSystemPromptAsync(mode);

            var messages = new List<Message>
            {
                new() { Role = "user", Content = new[] { ContentBlock.TextBlock(prompt) } }
            };

            var assistantText = new System.Text.StringBuilder();
            var iteration = 0;

            while (true)
            {
                iteration++;
                if (record.ToolCalls >= _options.Value.MaxToolCallsPerRun)
                {
                    await FailAsync(writer, session, runId, record, "Tool-call cap reached.");
                    return;
                }

                var request = new MessageRequest
                {
                    Model = _options.Value.Model,
                    MaxTokens = Math.Min(4096, _options.Value.MaxTokensPerRun),
                    System = systemPrompt,
                    Messages = messages.ToArray(),
                    Tools = ToolRegistry.Definitions
                };

                MessageResponse response;
                try
                {
                    response = await _anthropic.SendAsync(request, CancellationToken.None);
                }
                catch (Exception ex)
                {
                    _log.LogWarning(ex, "Agent run {RunId} failed at iteration {Iteration}", runId, iteration);
                    await FailAsync(writer, session, runId, record, ex.Message);
                    return;
                }

                if (response.Usage is { } usage)
                {
                    record.InputTokens += usage.InputTokens;
                    record.OutputTokens += usage.OutputTokens;
                    var accrue = _budget.Accrue(usage.InputTokens, usage.OutputTokens, perCredCap);
                    record.DollarsSpent += _budget.EstimateDollars(usage.InputTokens, usage.OutputTokens);

                    session.Totals.InputTokens = record.InputTokens;
                    session.Totals.OutputTokens = record.OutputTokens;
                    session.Totals.Dollars = record.DollarsSpent;

                    await EmitAsync(writer, session, new AgentEvent
                    {
                        Type = AgentEventType.UsageUpdate,
                        RunId = runId,
                        InputTokens = record.InputTokens,
                        OutputTokens = record.OutputTokens,
                        DollarsSpentInRun = record.DollarsSpent,
                        DollarsSpentToday = accrue.SpentToday,
                        DailyDollarCap = accrue.DailyCap
                    });

                    if (accrue.Exhausted)
                    {
                        await EmitAsync(writer, session, new AgentEvent
                        {
                            Type = AgentEventType.BudgetExhausted,
                            RunId = runId,
                            DollarsSpentToday = accrue.SpentToday,
                            DailyDollarCap = accrue.DailyCap
                        });
                        record.Status = AgentRunStatus.CancelledBudget;
                        record.CompletedAt = DateTimeOffset.UtcNow;
                        session.Status = "cancelledBudget";
                        session.CompletedAt = record.CompletedAt;
                        _store.Save(record);
                        await _sessions.SaveAsync(session);
                        writer.TryComplete();
                        return;
                    }

                    if (record.InputTokens + record.OutputTokens >= _options.Value.MaxTokensPerRun)
                    {
                        await FailAsync(writer, session, runId, record, "Per-run token cap reached.");
                        return;
                    }
                }

                var toolUseBlocks = response.Content.Where(b => b.Type == "tool_use").ToList();
                var hasTools = toolUseBlocks.Count > 0;

                // Walk content blocks in order. Text-before-tool-use becomes Narration;
                // text without a following tool_use is the terminal answer.
                string? pendingNarration = null;
                foreach (var block in response.Content)
                {
                    if (block.Type == "text" && !string.IsNullOrEmpty(block.Text))
                    {
                        var text = block.Text!;
                        await EmitAsync(writer, session, new AgentEvent
                        {
                            Type = AgentEventType.TextDelta,
                            RunId = runId,
                            Text = text
                        });

                        if (hasTools)
                        {
                            pendingNarration = (pendingNarration is null ? text : pendingNarration + text).Trim();
                        }
                        else
                        {
                            assistantText.Append(text);
                            await EmitAsync(writer, session, new AgentEvent
                            {
                                Type = AgentEventType.ComposingResponse,
                                RunId = runId,
                                Summary = text
                            });
                        }
                    }
                    else if (block.Type == "tool_use")
                    {
                        if (!string.IsNullOrEmpty(pendingNarration))
                        {
                            await EmitAsync(writer, session, new AgentEvent
                            {
                                Type = AgentEventType.Narration,
                                RunId = runId,
                                Summary = pendingNarration
                            });
                            pendingNarration = null;
                        }

                        await DispatchToolAsync(block, runId, record, session, writer);
                    }
                }

                if (!hasTools)
                {
                    record.AssistantText = assistantText.ToString();
                    record.Status = AgentRunStatus.Succeeded;
                    record.CompletedAt = DateTimeOffset.UtcNow;
                    session.Status = "succeeded";
                    session.CompletedAt = record.CompletedAt;
                    _store.Save(record);

                    await EmitAsync(writer, session, new AgentEvent
                    {
                        Type = AgentEventType.AssistantMessage,
                        RunId = runId,
                        Summary = record.AssistantText
                    });
                    await EmitAsync(writer, session, new AgentEvent
                    {
                        Type = AgentEventType.RunCompleted,
                        RunId = runId,
                        StopReason = response.StopReason
                    });
                    writer.TryComplete();
                    return;
                }

                messages.Add(new Message { Role = "assistant", Content = response.Content });

                // Re-dispatch the tool_use blocks to collect tool_results for the next
                // assistant turn. The categorised events were already emitted inside
                // DispatchToolAsync via the block walker; here we just rebuild the
                // message payload.
                var toolResults = new List<ContentBlock>();
                foreach (var block in toolUseBlocks)
                {
                    var toolUseId = block.Id ?? Guid.NewGuid().ToString("N");
                    var result = LastDispatchOutputs.TryGetValue((runId, toolUseId), out var captured)
                        ? captured
                        : new ToolResult(JsonValue.Create("missing")!, IsError: true);
                    toolResults.Add(ContentBlock.ToolResultBlock(toolUseId, result.Output, result.IsError));
                }
                messages.Add(new Message { Role = "user", Content = toolResults });
            }
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Agent run {RunId} crashed", runId);
            try { await FailAsync(writer, session, runId, record, ex.Message); } catch { }
        }
        finally
        {
            _budget.CompleteRun();
            // Keep last-output cache scoped per-run; clean up after completion.
            foreach (var key in LastDispatchOutputs.Keys.Where(k => k.RunId == runId).ToList())
            {
                LastDispatchOutputs.TryRemove(key, out _);
            }
        }
    }

    /// <summary>
    /// Dispatches a single tool_use block: emits raw started/completed events plus a
    /// categorised event (or ToolError on failure). Caches the dispatch output keyed
    /// by (runId, toolUseId) so the outer loop can rebuild the next message's
    /// tool_result blocks without dispatching again.
    /// </summary>
    private async Task DispatchToolAsync(
        ContentBlock block,
        string runId,
        AgentRunRecord record,
        SessionDoc session,
        ChannelWriter<AgentEvent> writer)
    {
        record.ToolCalls++;
        session.Totals.ToolCalls = record.ToolCalls;

        var toolName = block.Name ?? string.Empty;
        var toolUseId = block.Id ?? Guid.NewGuid().ToString("N");

        await EmitAsync(writer, session, new AgentEvent
        {
            Type = AgentEventType.ToolCallStarted,
            RunId = runId,
            ToolCallId = toolUseId,
            ToolName = toolName,
            ToolInput = block.Input
        });

        var startedAt = DateTimeOffset.UtcNow;
        var result = await _tools.DispatchAsync(toolName, block.Input, CancellationToken.None);
        var durationMs = (int)(DateTimeOffset.UtcNow - startedAt).TotalMilliseconds;
        LastDispatchOutputs[(runId, toolUseId)] = result;

        await EmitAsync(writer, session, new AgentEvent
        {
            Type = AgentEventType.ToolCallCompleted,
            RunId = runId,
            ToolCallId = toolUseId,
            ToolName = toolName,
            ToolOutput = result.Output,
            ToolIsError = result.IsError,
            DurationMs = durationMs
        });

        if (result.IsError)
        {
            await EmitAsync(writer, session, new AgentEvent
            {
                Type = AgentEventType.ToolError,
                RunId = runId,
                ToolCallId = toolUseId,
                ToolName = toolName,
                Summary = result.Output?.ToString(),
                DurationMs = durationMs
            });
            return;
        }

        var categorised = BuildCategorisedEvent(toolName, block.Input, result.Output, runId, toolUseId, durationMs);
        if (categorised is not null)
        {
            await EmitAsync(writer, session, categorised);
        }
    }

    private static AgentEvent? BuildCategorisedEvent(
        string toolName,
        JsonNode? input,
        JsonNode? output,
        string runId,
        string toolUseId,
        int durationMs)
    {
        switch (toolName)
        {
            case ToolRegistry.ReadMemory:
                return new AgentEvent
                {
                    Type = AgentEventType.ReadingMemory,
                    RunId = runId,
                    ToolCallId = toolUseId,
                    Path = input?["path"]?.GetValue<string>(),
                    DurationMs = durationMs
                };
            case ToolRegistry.ListMemory:
                return new AgentEvent
                {
                    Type = AgentEventType.ReadingMemory,
                    RunId = runId,
                    ToolCallId = toolUseId,
                    Count = output?["count"]?.GetValue<int?>(),
                    DurationMs = durationMs
                };
            case ToolRegistry.WriteMemory:
            case ToolRegistry.AppendMemory:
            case ToolRegistry.DeleteMemory:
                return new AgentEvent
                {
                    Type = AgentEventType.WritingMemory,
                    RunId = runId,
                    ToolCallId = toolUseId,
                    Path = input?["path"]?.GetValue<string>(),
                    DurationMs = durationMs
                };
            case ToolRegistry.ListEndpoints:
                return new AgentEvent
                {
                    Type = AgentEventType.DiscoveringEndpoints,
                    RunId = runId,
                    ToolCallId = toolUseId,
                    Count = output?["count"]?.GetValue<int?>(),
                    Summary = input?["area"]?.GetValue<string>(),
                    DurationMs = durationMs
                };
            case ToolRegistry.GetEndpointDetails:
                return new AgentEvent
                {
                    Type = AgentEventType.ExaminingEndpoint,
                    RunId = runId,
                    ToolCallId = toolUseId,
                    EndpointId = input?["id"]?.GetValue<string>(),
                    DurationMs = durationMs
                };
            default:
                return null;
        }
    }

    private async Task EmitAsync(ChannelWriter<AgentEvent> writer, SessionDoc session, AgentEvent evt)
    {
        lock (session.Events) session.Events.Add(evt);
        await writer.WriteAsync(evt);
        try { await _sessions.SaveAsync(session); }
        catch (Exception ex) { _log.LogWarning(ex, "Session save failed for run {RunId}", evt.RunId); }
    }

    private async Task FailAsync(
        ChannelWriter<AgentEvent> writer,
        SessionDoc session,
        string runId,
        AgentRunRecord record,
        string error)
    {
        record.Status = AgentRunStatus.Failed;
        record.Error = error;
        record.CompletedAt = DateTimeOffset.UtcNow;
        session.Status = "failed";
        session.Error = error;
        session.CompletedAt = record.CompletedAt;
        _store.Save(record);

        await EmitAsync(writer, session, new AgentEvent
        {
            Type = AgentEventType.RunFailed,
            RunId = runId,
            Error = error
        });
        writer.TryComplete();
    }

    /// <summary>
    /// Per-process cache of the last <see cref="ToolResult"/> for each (runId, toolUseId).
    /// We dispatch each tool inline during block walking so we can emit ordered events,
    /// but we also need the outputs again to rebuild the next assistant turn's
    /// <c>tool_result</c> blocks. Cleared in the run's <c>finally</c>.
    /// </summary>
    private static readonly ConcurrentDictionary<(string RunId, string ToolUseId), ToolResult> LastDispatchOutputs = new();

    private static async IAsyncEnumerable<T> EmptyAsync<T>()
    {
        await Task.CompletedTask;
        yield break;
    }

    private async Task<string> BuildSystemPromptAsync(AgentRunMode mode)
    {
        var introduce = await _memoryBootstrap.GetIntroduceAsync();
        var index = await _memoryBootstrap.GetIndexSnapshotAsync();
        var tail = mode == AgentRunMode.Scan ? ScanModeTail : ChatModeTail;
        return introduce + "\n\n---\n\n# Current memory index\n\n" + index + "\n\n---\n\n" + tail;
    }
}
