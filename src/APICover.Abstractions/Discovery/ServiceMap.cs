namespace APICover.Abstractions.Discovery;

/// <summary>
/// Topology view of the host: services + endpoints + external HTTP + DB boundaries
/// as nodes, call relationships as edges. Extends <see cref="ServiceCatalog"/> with
/// directed edges + per-node metrics (fan-in/fan-out, depth, coupling, instability,
/// reach counts) and connected-component "knowledge islands" so the UI can render a
/// navigable system map.
/// </summary>
public sealed class ServiceMap
{
    public required DateTimeOffset GeneratedAt { get; init; }
    public required IReadOnlyList<ServiceMapNode> Nodes { get; init; }
    public required IReadOnlyList<ServiceMapEdge> Edges { get; init; }

    /// <summary>Connected components of the undirected service+endpoint graph. Each
    /// island is an array of node ids that share at least one call edge transitively.
    /// Singleton islands typically indicate dead code or unwired surfaces.</summary>
    public required IReadOnlyList<IReadOnlyList<string>> Islands { get; init; }
}

public enum ServiceMapNodeKind
{
    Endpoint = 0,
    Service = 1,
    ExternalHttp = 2,
    Database = 3
}

public sealed class ServiceMapNode
{
    /// <summary>Unique id within the map. Endpoint ids are the existing
    /// <c>"METHOD /path"</c>; service ids are the declaring type's full name; external/DB
    /// ids are the boundary label prefixed with <c>"http:"</c> or <c>"db:"</c>.</summary>
    public required string Id { get; init; }

    public required ServiceMapNodeKind Kind { get; init; }

    /// <summary>Short display label.</summary>
    public required string Label { get; init; }

    /// <summary>Full identifier — controller type + method, declaring type, URL.</summary>
    public string? FullName { get; init; }

    /// <summary>For Service nodes: resolved concrete impl when DI is statically resolvable.</summary>
    public string? ResolvedImplType { get; init; }

    /// <summary>True when this is an interface contract (Service nodes only).</summary>
    public bool IsInterface { get; init; }

    /// <summary>HTTP method (GET, POST, …) for Endpoint nodes.</summary>
    public string? HttpMethod { get; init; }

    /// <summary>Logical area for Endpoint nodes.</summary>
    public string? Area { get; init; }

    /// <summary>Per-node metrics.</summary>
    public required ServiceMapMetrics Metrics { get; init; }

    /// <summary>Index into <see cref="ServiceMap.Islands"/>.</summary>
    public required int IslandIndex { get; init; }
}

public enum ServiceMapEdgeKind
{
    /// <summary>Endpoint dispatches to a service.</summary>
    Invokes = 0,
    /// <summary>Service calls another service inside the host.</summary>
    Calls = 1,
    /// <summary>Service hits an external HTTP boundary.</summary>
    Http = 2,
    /// <summary>Service hits a database boundary.</summary>
    Database = 3
}

public sealed class ServiceMapEdge
{
    public required string From { get; init; }
    public required string To { get; init; }
    public required ServiceMapEdgeKind Kind { get; init; }
    public required int CallSites { get; init; }
}

public sealed class ServiceMapMetrics
{
    /// <summary>Distinct upstream nodes that depend on this one.</summary>
    public required int FanIn { get; init; }

    /// <summary>Distinct downstream nodes this node depends on.</summary>
    public required int FanOut { get; init; }

    /// <summary>Maximum depth of the directed sub-graph rooted at this node.</summary>
    public required int Depth { get; init; }

    /// <summary>Distinct external HTTP boundaries reachable downstream.</summary>
    public required int ExternalReach { get; init; }

    /// <summary>Distinct database boundaries reachable downstream.</summary>
    public required int DatabaseReach { get; init; }

    /// <summary>Distinct service nodes reachable downstream (transitive).</summary>
    public required int ServiceReach { get; init; }

    /// <summary>For endpoints: distinct other endpoints sharing at least one downstream service.</summary>
    public int SiblingEndpoints { get; init; }

    /// <summary>Robert C. Martin's instability metric: <c>FanOut / (FanIn + FanOut)</c>. Null for orphans.</summary>
    public double? Instability { get; init; }

    /// <summary>Composite coupling score in [0, 100]. Weighted: 40% FanOut, 25% FanIn,
    /// 15% Depth, 10% ExternalReach, 10% DatabaseReach. Normalised against the map's max
    /// for each component so scores are comparable inside one map.</summary>
    public required double Coupling { get; init; }
}
