using System.Text.Json.Serialization;

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

    /// <summary>
    /// Guards <see cref="NodeResults"/> against concurrent mutation from forked branch tasks.
    /// All additions (see <see cref="RunExtensions.GetOrAddResult"/>) and
    /// <see cref="Snapshot"/> enumeration take this lock.
    /// </summary>
    [JsonIgnore]
    public object SyncRoot { get; } = new();

    /// <summary>
    /// Serialization-safe deep copy taken under <see cref="SyncRoot"/>. Hand this — never the
    /// live instance — to anything that serializes concurrently with execution (HTTP responses,
    /// SSE payloads, storage providers).
    /// </summary>
    public Run Snapshot()
    {
        lock (SyncRoot)
        {
            return new Run
            {
                Id = Id,
                ScenarioId = ScenarioId,
                Status = Status,
                StartedAt = StartedAt,
                CompletedAt = CompletedAt,
                Error = Error,
                PausedAtNodeId = PausedAtNodeId,
                NodeResults = NodeResults.Select(r => r.Snapshot()).ToList()
            };
        }
    }
}
