using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace APICover.Agent.Engine;

/// <summary>
/// Discriminated event types streamed to the UI as the agent works. The UI keeps a
/// static render-rule table keyed by this enum — adding a value is a coordinated
/// backend + frontend change.
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum AgentEventType
{
    // Lifecycle
    RunStarted,
    RunCompleted,
    RunFailed,
    BudgetExhausted,

    // Categorised work — emitted by the coordinator when it recognises a tool name
    Narration,                 // assistant text that precedes a tool_use block
    ReadingMemory,             // list_memory, read_memory
    WritingMemory,             // write_memory, append_memory, delete_memory
    DiscoveringEndpoints,      // list_endpoints
    ExaminingEndpoint,         // get_endpoint_details
    ToolError,                 // any tool result with isError=true

    // Final assistant output
    ComposingResponse,         // terminal text streaming (per delta)
    AssistantMessage,          // terminal text complete

    // Telemetry
    UsageUpdate,

    // Raw stream — kept for transcript "detail" expand. UI hides them by default
    // unless the user opts to inspect the underlying tool call.
    TextDelta,
    ToolCallStarted,
    ToolCallCompleted,
}

public sealed class AgentEvent
{
    public required AgentEventType Type { get; init; }
    public required string RunId { get; init; }
    public DateTimeOffset Timestamp { get; init; } = DateTimeOffset.UtcNow;

    /// <summary>
    /// Narration text in the user's prompt language. Set on <see cref="AgentEventType.Narration"/>,
    /// <see cref="AgentEventType.ComposingResponse"/> deltas, and the full assistant text on
    /// <see cref="AgentEventType.AssistantMessage"/>. Also used as a one-line summary on
    /// categorised work events when no path/endpoint id is available.
    /// </summary>
    public string? Summary { get; init; }

    /// <summary>Memory path for <see cref="AgentEventType.ReadingMemory"/> /
    /// <see cref="AgentEventType.WritingMemory"/>.</summary>
    public string? Path { get; init; }

    /// <summary>Endpoint id for <see cref="AgentEventType.ExaminingEndpoint"/>.</summary>
    public string? EndpointId { get; init; }

    /// <summary>Result-set count for <see cref="AgentEventType.DiscoveringEndpoints"/> and
    /// list-style memory reads.</summary>
    public int? Count { get; init; }

    /// <summary>Latency between the matching started/completed pair, when applicable.</summary>
    public int? DurationMs { get; init; }

    public string? Text { get; init; }

    public string? ToolCallId { get; init; }
    public string? ToolName { get; init; }
    public JsonNode? ToolInput { get; init; }
    public JsonNode? ToolOutput { get; init; }
    public bool? ToolIsError { get; init; }

    public int? InputTokens { get; init; }
    public int? OutputTokens { get; init; }
    public decimal? DollarsSpentInRun { get; init; }
    public decimal? DollarsSpentToday { get; init; }
    public decimal? DailyDollarCap { get; init; }

    public string? Error { get; init; }
    public string? StopReason { get; init; }
}
