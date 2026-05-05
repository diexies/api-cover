namespace APICover.Abstractions.Models;

/// <summary>
/// A directed edge between two <see cref="ApiNode"/>s in a scenario DAG.
/// </summary>
public sealed class Edge
{
    /// <summary>Source node id.</summary>
    public required string From { get; init; }

    /// <summary>Target node id.</summary>
    public required string To { get; init; }

    /// <summary>
    /// Execution mode for this edge. Multiple <see cref="EdgeMode.Parallel"/> edges leaving
    /// the same source fan out concurrently.
    /// </summary>
    public EdgeMode Mode { get; init; } = EdgeMode.Sequential;
}
