using APICover.Abstractions.Models;

namespace APICover.Abstractions.Services;

/// <summary>
/// Pub/sub channel for run lifecycle telemetry. The engine publishes events as it advances
/// through a scenario; the inspector's SSE endpoint subscribes and forwards them to the UI
/// so clients can replace polling with a live stream.
/// </summary>
public interface IRunEventBus
{
    /// <summary>Publish an event for <paramref name="runId"/>. Non-blocking; drops oldest on overflow.</summary>
    void Publish(string runId, RunEvent @event);

    /// <summary>Subscribe to events for a specific run. The channel completes when the run finishes.</summary>
    IAsyncEnumerable<RunEvent> SubscribeAsync(string runId, CancellationToken cancellationToken);
}

/// <summary>A single run lifecycle event (run-level status change or per-node update).</summary>
public sealed class RunEvent
{
    public required RunEventType Type { get; init; }
    public required string RunId { get; init; }
    public string? NodeId { get; init; }
    public DateTimeOffset Timestamp { get; init; } = DateTimeOffset.UtcNow;

    /// <summary>Branch path for node-scoped events (<c>NodeStarted</c>, <c>NodeCompleted</c>,
    /// <c>NodePaused</c>, <c>NodeResumed</c>, <c>BranchSpawned</c>, <c>BranchCompleted</c>).
    /// Empty / null ≡ root branch.</summary>
    public IList<string> BranchPath { get; init; } = new List<string>();

    /// <summary>Snapshot payload — full <see cref="Run"/> for run-level events,
    /// <see cref="NodeResult"/> for node-level events. Already deep-copied so subscribers see
    /// a stable snapshot.</summary>
    public object? Payload { get; init; }
}

public enum RunEventType
{
    RunStarted = 0,
    RunStatusChanged = 1,
    NodeStarted = 2,
    NodeCompleted = 3,
    NodePaused = 4,
    NodeResumed = 5,
    RunFinished = 6,
    /// <summary>Emitted once per variant when a CaseSet anchor forks the run.</summary>
    BranchSpawned = 7,
    /// <summary>Emitted when the last node of a forked branch terminates.</summary>
    BranchCompleted = 8
}
