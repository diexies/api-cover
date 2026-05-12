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

        // Synthetic application root. Anchors the whole map: every service node
        // gets wired to it so the graph collapses to a single connected component,
        // regardless of which controllers/minimal-endpoints share which downstream
        // dependencies. Also gives the UI a fixed centre for the tier layout.
        const string AppRootId = "app:host";
        EnsureBoundaryNode(nodes, AppRootId, ServiceMapNodeKind.Service, "Application");

        // Walk every persisted call graph straight from the endpoint. Endpoint →
        // service edges land directly so the user sees "GET /users invokes
        // IUserService" instead of "GET /users → Program → IUserService". Handler
        // classes (controllers, MapXxx extension classes) still appear as service
        // nodes — they get added by VisitChild whenever the controller method
        // calls a private helper on the same type, which keeps real controllers
        // visible without forcing them between every endpoint and its services.
        foreach (var graph in graphs)
        {
            EnsureEndpointNode(nodes, endpointById.GetValueOrDefault(graph.EndpointId), graph.EndpointId);
            foreach (var child in graph.RootCall.Calls)
            {
                VisitChild(child, graph.EndpointId, nodes, edges);
            }
        }

        // Wire app:host → every concrete service node so registered services
        // share a common root. Interfaces stay one hop out via the existing
        // interface→impl edge, so the natural path reads
        // app:host → impl → interface ← endpoint.
        foreach (var n in nodes.Values.Where(x => x.Kind == ServiceMapNodeKind.Service && x.Id != AppRootId).ToList())
        {
            if (n.IsInterface) continue;
            AddEdge(edges, AppRootId, n.Id, ServiceMapEdgeKind.Calls);
        }
        // Endpoints that reach a service / DB / external boundary downstream
        // get a direct app:host edge so the map collapses to one component
        // (boundary-only endpoints would otherwise form their own island with
        // their boundary). Endpoints with NO outgoing edge — typically handlers
        // backed by an in-memory dictionary the walker can't classify — are
        // flagged isolated and surfaced in the side rail instead of cluttering
        // the canvas.
        foreach (var n in nodes.Values.Where(x => x.Kind == ServiceMapNodeKind.Endpoint).ToList())
        {
            var hasOutgoing = edges.Keys.Any(k => k.From == n.Id);
            if (hasOutgoing)
            {
                AddEdge(edges, AppRootId, n.Id, ServiceMapEdgeKind.Invokes);
            }
            else
            {
                n.IsIsolated = true;
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

        // Tier level by node kind, not by BFS distance. Predictable concentric
        // rings: app root in the middle, services + interfaces around it, APIs
        // on the next ring, external/db boundaries at the rim. Keeping this
        // kind-driven means a service that's only reachable through a long
        // call chain still lives on the services ring instead of drifting out.
        int LevelFor(MutableNode n)
        {
            if (n.Id == AppRootId) return 0;
            return n.Kind switch
            {
                ServiceMapNodeKind.Service => 1,
                ServiceMapNodeKind.Endpoint => 2,
                ServiceMapNodeKind.ExternalHttp => 3,
                ServiceMapNodeKind.Database => 3,
                _ => 1
            };
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
            var level = LevelFor(n);

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
                Level = level,
                IsIsolated = n.IsIsolated,
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
            {
                if (node.DeclaringType is not { Length: > 0 } declaring)
                {
                    foreach (var c in node.Calls) VisitChild(c, callerId, nodes, edges);
                    return;
                }
                // Pass-through hubs: MediatR.ISender / IMediator / IPublisher are dispatch
                // shims, not real dependencies. Emitting an edge to ISender pulls every
                // handler in the system under one node (fan-out 200+) the moment any
                // endpoint that hops through Mediator is rendered. Bypass ISender so the
                // call goes directly to the resolved handler, which is what the user
                // actually depends on. Same for shared logger / cache facades.
                if (IsPassThroughHub(declaring) && node.ResolvedImplType is { Length: > 0 } hubImpl)
                {
                    EnsureServiceNode(nodes, hubImpl, isInterface: false, resolvedImpl: null);
                    AddEdge(edges, callerId, hubImpl, MapEdgeKindForCaller(callerId, nodes));
                    foreach (var c in node.Calls) VisitChild(c, hubImpl, nodes, edges);
                    return;
                }

                EnsureServiceNode(nodes, declaring, isInterface: true, resolvedImpl: node.ResolvedImplType);
                AddEdge(edges, callerId, declaring, MapEdgeKindForCaller(callerId, nodes));
                // Promote the resolved concrete impl to its own service node and emit
                // the missing interface→impl edge so the DI binding shows up in the
                // map. Without this, the impl's downstream calls would attach to the
                // interface node and the impl itself would float as an orphan
                // (or never appear at all).
                var nextCaller = declaring;
                if (node.ResolvedImplType is { Length: > 0 } impl && !string.Equals(impl, declaring, StringComparison.Ordinal))
                {
                    EnsureServiceNode(nodes, impl, isInterface: false, resolvedImpl: null);
                    AddEdge(edges, declaring, impl, ServiceMapEdgeKind.Calls);
                    nextCaller = impl;
                }
                foreach (var c in node.Calls) VisitChild(c, nextCaller, nodes, edges);
                return;
            }
            case CallNodeKind.Method:
            {
                if (node.DeclaringType is not { Length: > 0 } declaring)
                {
                    foreach (var c in node.Calls) VisitChild(c, callerId, nodes, edges);
                    return;
                }
                var methodName = node.MethodName ?? string.Empty;
                if (IsAccessorOrCtor(methodName) || IsCompilerGenerated(methodName))
                {
                    // Property accessors, ctors, and compiler-generated members
                    // (record `with` clones, equality helpers, deconstructors)
                    // are noise — don't promote their declaring type to a
                    // service node. Recurse into their children in case real
                    // calls hide inside the body.
                    foreach (var c in node.Calls) VisitChild(c, callerId, nodes, edges);
                    return;
                }
                EnsureServiceNode(nodes, declaring, isInterface: false, resolvedImpl: node.ResolvedImplType);
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
                var entity = ExtractEntityShortName(node.DeclaringType);
                var category = CategoriseDbMethod(node.MethodName);
                var label = entity is null ? $"db {category}" : $"{entity} · {category}";
                // Stable id: entity + category dedupe so "Invoice.Add" and
                // "Invoice.AddAsync" collapse into one "Invoice · insert" node.
                var nodeId = entity is null ? $"db:{category}" : $"db:{entity}.{category}";
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

    /// <summary>Interfaces that act as pass-through dispatch shims rather than real
    /// dependencies. Used by VisitChild to skip the shim node and emit a direct edge
    /// from the caller to the resolved implementation — keeps shared hubs from pulling
    /// every consumer into one ball.</summary>
    private static bool IsPassThroughHub(string declaringType)
    {
        return declaringType switch
        {
            "MediatR.ISender" => true,
            "MediatR.IMediator" => true,
            "MediatR.IPublisher" => true,
            _ => false
        };
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

    /// <summary>BFS distance from <paramref name="root"/> over the undirected projection
    /// of the call graph. Returns a level for every node that can reach (or be reached
    /// from) the root; unreachable nodes are absent from the result.</summary>
    private static Dictionary<string, int> ComputeLevels(
        IEnumerable<string> nodeIds,
        Dictionary<(string From, string To, ServiceMapEdgeKind Kind), int> edges,
        string root)
    {
        var adj = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        foreach (var id in nodeIds) adj[id] = new HashSet<string>(StringComparer.Ordinal);
        foreach (var ((from, to, _), _) in edges)
        {
            if (adj.TryGetValue(from, out var fl)) fl.Add(to);
            if (adj.TryGetValue(to, out var tl)) tl.Add(from);
        }

        var levels = new Dictionary<string, int>(StringComparer.Ordinal);
        if (!adj.ContainsKey(root)) return levels;
        var queue = new Queue<string>();
        queue.Enqueue(root);
        levels[root] = 0;
        while (queue.Count > 0)
        {
            var cur = queue.Dequeue();
            var depth = levels[cur];
            foreach (var n in adj[cur])
            {
                if (levels.ContainsKey(n)) continue;
                levels[n] = depth + 1;
                queue.Enqueue(n);
            }
        }
        return levels;
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

    /// <summary>
    /// Resolve the user-visible handler class for a HandlerTypeName so every endpoint
    /// can connect to a service node. Strips the trailing <c>.{ActionName}</c> segment
    /// and then peels compiler-generated nested types (<c>+&lt;&gt;c</c>,
    /// <c>+&lt;&gt;c__DisplayClass</c>, <c>+&lt;Method&gt;d__N</c>) so minimal-API
    /// route registrations land on the outer class that owns them
    /// (e.g. <c>InvoicingEndpoints</c>, <c>Program</c>) instead of the lambda's
    /// synthetic display class.
    /// </summary>
    /// <summary>
    /// Map an EF / Dapper / ADO.NET method name to a friendly category that
    /// reads like a verb on the database. Falls back to the lowered method
    /// name when nothing matches so we still get a human-ish label.
    /// </summary>
    private static string CategoriseDbMethod(string? methodName)
    {
        if (string.IsNullOrEmpty(methodName)) return "op";
        return methodName switch
        {
            "Add" or "AddAsync" or "AddRange" or "AddRangeAsync" => "insert",
            "SaveChanges" or "SaveChangesAsync" => "save",
            "Find" or "FindAsync" => "search",
            "Update" or "UpdateRange" or "ExecuteUpdate" or "ExecuteUpdateAsync" => "update",
            "Remove" or "RemoveRange" or "ExecuteDelete" or "ExecuteDeleteAsync" => "delete",
            "Attach" or "AttachRange" => "attach",
            "ExecuteNonQuery" or "ExecuteNonQueryAsync" => "exec",
            "ExecuteReader" or "ExecuteReaderAsync" => "read",
            "ExecuteScalar" or "ExecuteScalarAsync" => "scalar",
            "Load" or "LoadAsync" => "load",
            _ when methodName.StartsWith("Query", StringComparison.Ordinal) => "query",
            _ when methodName.StartsWith("Execute", StringComparison.Ordinal) => "exec",
            _ when methodName.EndsWith("Async", StringComparison.Ordinal) =>
                methodName[..^5].ToLowerInvariant(),
            _ => methodName.ToLowerInvariant()
        };
    }

    /// <summary>
    /// Pull the user-visible entity short name out of a generic boundary's
    /// FullName. <c>Microsoft.EntityFrameworkCore.DbSet`1[[Foo.Bar.Invoice,
    /// Foo, ...]]</c> → <c>Invoice</c>. Returns <c>null</c> for non-generic
    /// boundary types (e.g. <c>DbContext.SaveChangesAsync</c>).
    /// </summary>
    private static string? ExtractEntityShortName(string? declaringType)
    {
        if (string.IsNullOrEmpty(declaringType)) return null;
        var open = declaringType.IndexOf("[[", StringComparison.Ordinal);
        if (open < 0) return null;
        var close = declaringType.IndexOf(']', open + 2);
        if (close < 0) return null;
        var inner = declaringType.Substring(open + 2, close - open - 2);
        var comma = inner.IndexOf(',');
        var fullName = (comma > 0 ? inner.Substring(0, comma) : inner).Trim();
        if (fullName.Length == 0) return null;
        var dot = fullName.LastIndexOf('.');
        return dot >= 0 ? fullName.Substring(dot + 1) : fullName;
    }

    private static string? ResolveHandlerClass(string? handlerTypeName)
    {
        if (string.IsNullOrEmpty(handlerTypeName)) return null;
        var lastDot = handlerTypeName.LastIndexOf('.');
        if (lastDot <= 0) return null;
        var cls = handlerTypeName.Substring(0, lastDot);
        var plus = cls.IndexOf("+<", StringComparison.Ordinal);
        if (plus > 0) cls = cls.Substring(0, plus);
        if (cls.Length == 0) return null;
        if (cls.StartsWith("<", StringComparison.Ordinal)) return null;
        return cls;
    }

    private static bool IsAccessorOrCtor(string name) =>
        name == ".ctor" || name == ".cctor"
        || name.StartsWith("get_", StringComparison.Ordinal)
        || name.StartsWith("set_", StringComparison.Ordinal)
        || name.StartsWith("add_", StringComparison.Ordinal)
        || name.StartsWith("remove_", StringComparison.Ordinal);

    private static bool IsCompilerGenerated(string name) =>
        name.StartsWith("<", StringComparison.Ordinal)
        || name == "ToString" || name == "GetHashCode" || name == "Equals"
        || name == "Deconstruct" || name == "PrintMembers";

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
        public bool IsIsolated { get; set; }
        public HashSet<string> FanInSet { get; } = new(StringComparer.Ordinal);
        public HashSet<string> FanOutSet { get; } = new(StringComparer.Ordinal);
    }
}
