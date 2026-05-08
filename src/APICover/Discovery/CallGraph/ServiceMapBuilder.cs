using APICover.Abstractions.Discovery;
using APICover.Abstractions.Services;

namespace APICover.Discovery.CallGraph;

/// <summary>
/// Default <see cref="IServiceMapService"/>. Walks every persisted
/// <see cref="CallGraphNode"/> exactly once, emits nodes + directed edges, derives
/// per-node metrics (fan-in / fan-out / depth / instability / coupling), and runs
/// connected-component detection over the undirected projection to surface
/// "knowledge islands".
/// </summary>
internal sealed class ServiceMapBuilder : IServiceMapService
{
    private readonly ICallGraphStore _store;
    private readonly IEndpointDiscoveryService _discovery;

    public ServiceMapBuilder(ICallGraphStore store, IEndpointDiscoveryService discovery)
    {
        _store = store;
        _discovery = discovery;
    }

    public async Task<ServiceMap> BuildAsync(CancellationToken cancellationToken = default)
    {
        var graphs = await _store.ListAsync(cancellationToken).ConfigureAwait(false);
        var endpoints = _discovery.GetEndpoints();
        var endpointById = endpoints.ToDictionary(e => e.Id, StringComparer.Ordinal);

        var nodes = new Dictionary<string, MutableNode>(StringComparer.Ordinal);
        var edges = new Dictionary<(string From, string To, ServiceMapEdgeKind Kind), int>();

        // Seed endpoint nodes from discovery so endpoints with no resolvable graph still
        // appear (they'll end up in their own singleton island).
        foreach (var ep in endpoints)
        {
            EnsureEndpointNode(nodes, ep);
        }

        foreach (var graph in graphs)
        {
            EnsureEndpointNode(nodes, endpointById.GetValueOrDefault(graph.EndpointId), graph.EndpointId);
            // Children of the root are the entry edges (endpoint → first service).
            foreach (var child in graph.RootCall.Calls)
            {
                VisitChild(child, graph.EndpointId, nodes, edges);
            }
        }

        // Compute fanIn / fanOut from accumulated edges.
        foreach (var ((from, to, _), _) in edges)
        {
            if (nodes.TryGetValue(from, out var fromNode)) fromNode.FanOutSet.Add(to);
            if (nodes.TryGetValue(to, out var toNode)) toNode.FanInSet.Add(from);
        }

        // Reachability via DFS, memoised.
        var adjacency = BuildAdjacency(edges);
        var reachCache = new Dictionary<string, ReachInfo>(StringComparer.Ordinal);
        foreach (var nodeId in nodes.Keys)
        {
            ComputeReach(nodeId, adjacency, nodes, reachCache, new HashSet<string>(StringComparer.Ordinal));
        }

        // Sibling-endpoint count.
        var endpointReach = nodes.Values.Where(n => n.Kind == ServiceMapNodeKind.Endpoint)
            .ToDictionary(n => n.Id, n => reachCache[n.Id].Services, StringComparer.Ordinal);
        var siblingCounts = ComputeSiblingCounts(endpointReach);

        // Connected components.
        var islandByNode = ComputeIslands(nodes.Keys, edges);
        var islandsList = new List<List<string>>();
        var islandIndexMap = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var (nodeId, key) in islandByNode)
        {
            if (!islandIndexMap.TryGetValue(key, out var idx))
            {
                idx = islandsList.Count;
                islandIndexMap[key] = idx;
                islandsList.Add(new List<string>());
            }
            islandsList[idx].Add(nodeId);
        }

        // Coupling normalisation.
        var maxFanIn = Math.Max(1, nodes.Values.Max(n => n.FanInSet.Count));
        var maxFanOut = Math.Max(1, nodes.Values.Max(n => n.FanOutSet.Count));
        var maxDepth = Math.Max(1, reachCache.Values.Max(r => r.Depth));
        var maxExt = Math.Max(1, reachCache.Values.Max(r => r.Externals.Count));
        var maxDb = Math.Max(1, reachCache.Values.Max(r => r.Databases.Count));

        var nodeList = new List<ServiceMapNode>(nodes.Count);
        foreach (var n in nodes.Values)
        {
            var reach = reachCache[n.Id];
            var fanIn = n.FanInSet.Count;
            var fanOut = n.FanOutSet.Count;
            var instability = (fanIn + fanOut) == 0 ? (double?)null : (double)fanOut / (fanIn + fanOut);
            var coupling =
                  0.40 * ((double)fanOut / maxFanOut) * 100
                + 0.25 * ((double)fanIn / maxFanIn) * 100
                + 0.15 * ((double)reach.Depth / maxDepth) * 100
                + 0.10 * ((double)reach.Externals.Count / maxExt) * 100
                + 0.10 * ((double)reach.Databases.Count / maxDb) * 100;

            siblingCounts.TryGetValue(n.Id, out var siblings);
            islandIndexMap.TryGetValue(islandByNode[n.Id], out var island);

            nodeList.Add(new ServiceMapNode
            {
                Id = n.Id,
                Kind = n.Kind,
                Label = n.Label,
                FullName = n.FullName,
                ResolvedImplType = n.ResolvedImplType,
                IsInterface = n.IsInterface,
                HttpMethod = n.HttpMethod,
                Area = n.Area,
                IslandIndex = island,
                Metrics = new ServiceMapMetrics
                {
                    FanIn = fanIn,
                    FanOut = fanOut,
                    Depth = reach.Depth,
                    ExternalReach = reach.Externals.Count,
                    DatabaseReach = reach.Databases.Count,
                    ServiceReach = reach.Services.Count,
                    SiblingEndpoints = siblings,
                    Instability = instability,
                    Coupling = Math.Round(coupling, 2)
                }
            });
        }

        var edgeList = edges
            .Select(kv => new ServiceMapEdge
            {
                From = kv.Key.From,
                To = kv.Key.To,
                Kind = kv.Key.Kind,
                CallSites = kv.Value
            })
            .OrderBy(e => e.From, StringComparer.Ordinal)
            .ThenBy(e => e.To, StringComparer.Ordinal)
            .ToList();

        return new ServiceMap
        {
            GeneratedAt = DateTimeOffset.UtcNow,
            Nodes = nodeList
                .OrderByDescending(n => n.Metrics.Coupling)
                .ThenBy(n => n.Label, StringComparer.Ordinal)
                .ToList(),
            Edges = edgeList,
            Islands = islandsList
                .Select(l => (IReadOnlyList<string>)l.OrderBy(s => s, StringComparer.Ordinal).ToList())
                .ToList()
        };
    }

    private static void EnsureEndpointNode(
        Dictionary<string, MutableNode> nodes,
        EndpointDescriptor? ep,
        string? fallbackId = null)
    {
        var id = ep?.Id ?? fallbackId;
        if (id is null) return;
        if (nodes.ContainsKey(id)) return;
        nodes[id] = new MutableNode
        {
            Id = id,
            Kind = ServiceMapNodeKind.Endpoint,
            Label = ep?.DisplayName ?? id,
            FullName = ep?.HandlerTypeName,
            HttpMethod = ep?.Method,
            Area = ep?.Area
        };
    }

    /// <summary>
    /// Recurse into the call tree; emit edge from the nearest "node-of-interest"
    /// ancestor (endpoint or service) to whichever node-of-interest we encounter
    /// next. Method-level intermediates collapse so the graph stays at the
    /// service level.
    /// </summary>
    private static void VisitChild(
        CallNode node,
        string callerId,
        Dictionary<string, MutableNode> nodes,
        Dictionary<(string, string, ServiceMapEdgeKind), int> edges)
    {
        switch (node.Kind)
        {
            case CallNodeKind.Interface:
            case CallNodeKind.Method:
            {
                if (node.DeclaringType is not { Length: > 0 } declaring)
                {
                    foreach (var c in node.Calls) VisitChild(c, callerId, nodes, edges);
                    return;
                }
                if (node.Kind == CallNodeKind.Method && IsAccessorOrCtor(node.MethodName ?? string.Empty))
                {
                    foreach (var c in node.Calls) VisitChild(c, callerId, nodes, edges);
                    return;
                }
                EnsureServiceNode(nodes, declaring,
                    isInterface: node.Kind == CallNodeKind.Interface,
                    resolvedImpl: node.ResolvedImplType);
                AddEdge(edges, callerId, declaring, MapEdgeKindForCaller(callerId, nodes));
                foreach (var c in node.Calls) VisitChild(c, declaring, nodes, edges);
                return;
            }
            case CallNodeKind.ExternalHttp:
            {
                var label = ExtractUrl(node.Notes) ?? $"{node.DeclaringType}.{node.MethodName}";
                var nodeId = "http:" + label;
                EnsureBoundaryNode(nodes, nodeId, ServiceMapNodeKind.ExternalHttp, label);
                AddEdge(edges, callerId, nodeId, ServiceMapEdgeKind.Http);
                return;
            }
            case CallNodeKind.Database:
            {
                var label = $"{node.DeclaringType}.{node.MethodName}";
                var nodeId = "db:" + label;
                EnsureBoundaryNode(nodes, nodeId, ServiceMapNodeKind.Database, label);
                AddEdge(edges, callerId, nodeId, ServiceMapEdgeKind.Database);
                return;
            }
            default:
            {
                foreach (var c in node.Calls) VisitChild(c, callerId, nodes, edges);
                return;
            }
        }
    }

    private static ServiceMapEdgeKind MapEdgeKindForCaller(string callerId, Dictionary<string, MutableNode> nodes)
        => nodes.TryGetValue(callerId, out var caller) && caller.Kind == ServiceMapNodeKind.Endpoint
            ? ServiceMapEdgeKind.Invokes
            : ServiceMapEdgeKind.Calls;

    private static void EnsureServiceNode(
        Dictionary<string, MutableNode> nodes,
        string declaringType,
        bool isInterface,
        string? resolvedImpl)
    {
        if (nodes.TryGetValue(declaringType, out var existing))
        {
            if (existing.Kind != ServiceMapNodeKind.Service) return;
            existing.IsInterface = existing.IsInterface || isInterface;
            if (existing.ResolvedImplType is null && resolvedImpl is { Length: > 0 })
                existing.ResolvedImplType = resolvedImpl;
            return;
        }
        nodes[declaringType] = new MutableNode
        {
            Id = declaringType,
            Kind = ServiceMapNodeKind.Service,
            Label = ShortName(declaringType),
            FullName = declaringType,
            IsInterface = isInterface,
            ResolvedImplType = resolvedImpl
        };
    }

    private static void EnsureBoundaryNode(
        Dictionary<string, MutableNode> nodes,
        string id,
        ServiceMapNodeKind kind,
        string label)
    {
        if (nodes.ContainsKey(id)) return;
        nodes[id] = new MutableNode
        {
            Id = id,
            Kind = kind,
            Label = label,
            FullName = label
        };
    }

    private static void AddEdge(
        Dictionary<(string, string, ServiceMapEdgeKind), int> edges,
        string from,
        string to,
        ServiceMapEdgeKind kind)
    {
        if (from == to) return;
        var key = (from, to, kind);
        edges[key] = edges.TryGetValue(key, out var prev) ? prev + 1 : 1;
    }

    private static Dictionary<string, List<string>> BuildAdjacency(
        Dictionary<(string From, string To, ServiceMapEdgeKind Kind), int> edges)
    {
        var adj = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var ((from, to, _), _) in edges)
        {
            if (!adj.TryGetValue(from, out var list))
            {
                list = new List<string>();
                adj[from] = list;
            }
            list.Add(to);
        }
        return adj;
    }

    private sealed record ReachInfo(int Depth, HashSet<string> Services, HashSet<string> Externals, HashSet<string> Databases);

    private static ReachInfo ComputeReach(
        string nodeId,
        Dictionary<string, List<string>> adjacency,
        Dictionary<string, MutableNode> nodes,
        Dictionary<string, ReachInfo> cache,
        HashSet<string> stack)
    {
        if (cache.TryGetValue(nodeId, out var hit)) return hit;
        if (!stack.Add(nodeId))
        {
            return new ReachInfo(0,
                new HashSet<string>(StringComparer.Ordinal),
                new HashSet<string>(StringComparer.Ordinal),
                new HashSet<string>(StringComparer.Ordinal));
        }

        var services = new HashSet<string>(StringComparer.Ordinal);
        var externals = new HashSet<string>(StringComparer.Ordinal);
        var databases = new HashSet<string>(StringComparer.Ordinal);
        var depth = 0;

        if (adjacency.TryGetValue(nodeId, out var children))
        {
            foreach (var to in children)
            {
                if (nodes.TryGetValue(to, out var toNode))
                {
                    switch (toNode.Kind)
                    {
                        case ServiceMapNodeKind.Service: services.Add(to); break;
                        case ServiceMapNodeKind.ExternalHttp: externals.Add(to); break;
                        case ServiceMapNodeKind.Database: databases.Add(to); break;
                    }
                }
                var sub = ComputeReach(to, adjacency, nodes, cache, stack);
                services.UnionWith(sub.Services);
                externals.UnionWith(sub.Externals);
                databases.UnionWith(sub.Databases);
                if (sub.Depth + 1 > depth) depth = sub.Depth + 1;
            }
        }

        stack.Remove(nodeId);
        var result = new ReachInfo(depth, services, externals, databases);
        cache[nodeId] = result;
        return result;
    }

    private static Dictionary<string, int> ComputeSiblingCounts(Dictionary<string, HashSet<string>> endpointToServices)
    {
        var serviceToEndpoints = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        foreach (var (epId, services) in endpointToServices)
        {
            foreach (var svc in services)
            {
                if (!serviceToEndpoints.TryGetValue(svc, out var set))
                {
                    set = new HashSet<string>(StringComparer.Ordinal);
                    serviceToEndpoints[svc] = set;
                }
                set.Add(epId);
            }
        }
        var result = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var (epId, services) in endpointToServices)
        {
            var siblings = new HashSet<string>(StringComparer.Ordinal);
            foreach (var svc in services)
            {
                if (serviceToEndpoints.TryGetValue(svc, out var set))
                    siblings.UnionWith(set);
            }
            siblings.Remove(epId);
            result[epId] = siblings.Count;
        }
        return result;
    }

    private static Dictionary<string, string> ComputeIslands(
        IEnumerable<string> nodeIds,
        Dictionary<(string From, string To, ServiceMapEdgeKind Kind), int> edges)
    {
        var parent = nodeIds.ToDictionary(id => id, id => id, StringComparer.Ordinal);

        string Find(string x)
        {
            while (parent[x] != x)
            {
                parent[x] = parent[parent[x]];
                x = parent[x];
            }
            return x;
        }
        void Union(string a, string b)
        {
            var ra = Find(a);
            var rb = Find(b);
            if (ra != rb) parent[ra] = rb;
        }

        foreach (var ((from, to, _), _) in edges)
        {
            if (parent.ContainsKey(from) && parent.ContainsKey(to)) Union(from, to);
        }

        return parent.ToDictionary(kv => kv.Key, kv => Find(kv.Key), StringComparer.Ordinal);
    }

    private static string ShortName(string fullName)
    {
        var dot = fullName.LastIndexOf('.');
        return dot < 0 ? fullName : fullName.Substring(dot + 1);
    }

    private static bool IsAccessorOrCtor(string name) =>
        name == ".ctor" || name == ".cctor"
        || name.StartsWith("get_", StringComparison.Ordinal)
        || name.StartsWith("set_", StringComparison.Ordinal)
        || name.StartsWith("add_", StringComparison.Ordinal)
        || name.StartsWith("remove_", StringComparison.Ordinal);

    private static string? ExtractUrl(string? notes)
    {
        if (string.IsNullOrEmpty(notes)) return null;
        const string prefix = "→ ";
        return notes.StartsWith(prefix, StringComparison.Ordinal) ? notes.Substring(prefix.Length) : null;
    }

    private sealed class MutableNode
    {
        public required string Id { get; init; }
        public required ServiceMapNodeKind Kind { get; init; }
        public required string Label { get; set; }
        public string? FullName { get; set; }
        public string? ResolvedImplType { get; set; }
        public bool IsInterface { get; set; }
        public string? HttpMethod { get; set; }
        public string? Area { get; set; }
        public HashSet<string> FanInSet { get; } = new(StringComparer.Ordinal);
        public HashSet<string> FanOutSet { get; } = new(StringComparer.Ordinal);
    }
}
