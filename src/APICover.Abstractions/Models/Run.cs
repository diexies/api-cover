namespace APICover.Abstractions.Models;

/// <summary>
/// A single execution instance of a <see cref="Scenario"/>.
/// </summary>
public sealed class Run
{
    public required string Id { get; init; }
    public required string ScenarioId { get; init; }

    public RunStatus Status { get; set; } = RunStatus.Pending;

    public DateTimeOffset StartedAt { get; init; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? CompletedAt { get; set; }

    /// <summary>
    /// Per-(node, branch) execution records. With case-based branching, a single node can appear
    /// in multiple records — one per branch path. Use <see cref="RunExtensions.GetResult"/> to
    /// look up a specific (nodeId, branchPath) pair.
    /// </summary>
    public IList<NodeResult> NodeResults { get; init; } = new List<NodeResult>();

    /// <summary>Top-level error message if the run failed before reaching a specific node.</summary>
    public string? Error { get; set; }

    /// <summary>If the run is currently paused at a breakpoint, the node id where it stopped.</summary>
    public string? PausedAtNodeId { get; set; }
}
