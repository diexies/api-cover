using System.Text.Json.Serialization;

namespace APICover.Agent.Engine;

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum AgentRunStatus
{
    Pending,
    Running,
    Succeeded,
    Failed,
    CancelledByUser,
    CancelledBudget
}

public sealed class AgentRunRecord
{
    public required string Id { get; init; }
    public required string Prompt { get; init; }
    public required DateTimeOffset StartedAt { get; init; }
    public DateTimeOffset? CompletedAt { get; set; }
    public AgentRunStatus Status { get; set; } = AgentRunStatus.Pending;
    /// <summary>Run mode (chat / scan / scenario). Recorded so the UI can find an
    /// in-flight scan after a refresh and re-show its progress.</summary>
    public string? Mode { get; set; }
    public string? Error { get; set; }
    public int InputTokens { get; set; }
    public int OutputTokens { get; set; }
    public decimal DollarsSpent { get; set; }
    public int ToolCalls { get; set; }
    public string? AssistantText { get; set; }
}
