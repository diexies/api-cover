namespace APICover.Abstractions.Models;

/// <summary>
/// Mode of an outgoing edge from a node.
/// </summary>
public enum EdgeMode
{
    /// <summary>The target node executes after the source node completes (default).</summary>
    Sequential = 0,

    /// <summary>Multiple parallel-mode edges from the same source fan out concurrently.</summary>
    Parallel = 1
}

/// <summary>
/// Status of a single node within a run.
/// </summary>
public enum NodeStatus
{
    Pending = 0,
    Running = 1,
    Paused = 2,
    Succeeded = 3,
    Failed = 4,
    Skipped = 5,
    Cancelled = 6
}

/// <summary>
/// Status of an entire scenario run.
/// </summary>
public enum RunStatus
{
    Pending = 0,
    Running = 1,
    Paused = 2,
    Succeeded = 3,
    Failed = 4,
    Cancelled = 5
}
