using APICover.Agent.Engine;

namespace APICover.Agent.Sessions;

/// <summary>One persistent agent run, replayable from the JSON file. Holds the full
/// event timeline (in emission order) plus aggregate totals.</summary>
public sealed class SessionDoc
{
    public required string Id { get; init; }
    public required string Prompt { get; init; }
    public required string Mode { get; init; }
    public required DateTimeOffset StartedAt { get; init; }
    public DateTimeOffset? CompletedAt { get; set; }
    public required string Status { get; set; }
    public required string Model { get; init; }

    public List<AgentEvent> Events { get; set; } = new();
    public SessionTotals Totals { get; set; } = new();

    public string? Error { get; set; }
}

public sealed class SessionTotals
{
    public int InputTokens { get; set; }
    public int OutputTokens { get; set; }
    public decimal Dollars { get; set; }
    public int ToolCalls { get; set; }
}

public sealed record SessionSummary(
    string Id,
    string Prompt,
    string Mode,
    DateTimeOffset StartedAt,
    DateTimeOffset? CompletedAt,
    string Status,
    SessionTotals Totals);
