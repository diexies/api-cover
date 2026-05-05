namespace APICover.Abstractions.Models;

/// <summary>
/// A scenario: a DAG of <see cref="ApiNode"/>s connected by <see cref="Edge"/>s, plus
/// optional breakpoints and metadata. Scenarios are JSON-defined (created in the UI or
/// uploaded via the HTTP API) — the engine treats the persisted JSON as the single source
/// of truth and never synthesises scenarios from code.
/// </summary>
public sealed class Scenario
{
    /// <summary>Stable scenario id.</summary>
    public required string Id { get; init; }

    /// <summary>Display name.</summary>
    public required string Name { get; init; }

    /// <summary>Optional long description.</summary>
    public string? Description { get; init; }

    /// <summary>Free-form labels (e.g. "checkout", "auth"). Used to group flows in the sidebar.</summary>
    public IList<string> Tags { get; init; } = new List<string>();

    /// <summary>Nodes in the scenario (keyed by <see cref="ApiNode.Id"/>).</summary>
    public IList<ApiNode> Nodes { get; init; } = new List<ApiNode>();

    /// <summary>Edges connecting nodes.</summary>
    public IList<Edge> Edges { get; init; } = new List<Edge>();

    /// <summary>
    /// Ids of nodes that should start the run. If empty, the engine picks all nodes that
    /// have no incoming edge.
    /// </summary>
    public IList<string> StartNodeIds { get; init; } = new List<string>();

    /// <summary>Breakpoints currently set on this scenario (by node id).</summary>
    public IList<Breakpoint> Breakpoints { get; init; } = new List<Breakpoint>();

    /// <summary>Repeatable subgraphs with per-iteration mutations.</summary>
    public IList<ExecutionGroup> Groups { get; init; } = new List<ExecutionGroup>();

    /// <summary>Branching anchors. Each <see cref="CaseSet"/> forks the run into N variants at its
    /// anchor node. Multiple CaseSets compose multiplicatively when they sit on different paths.</summary>
    public IList<CaseSet> CaseSets { get; init; } = new List<CaseSet>();

    public DateTimeOffset CreatedAt { get; init; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}
