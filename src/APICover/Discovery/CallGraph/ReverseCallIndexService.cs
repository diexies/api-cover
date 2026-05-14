using APICover.Abstractions.Discovery;
using APICover.Abstractions.Services;

namespace APICover.Discovery.CallGraph;

/// <summary>
/// Reverse fan-in builder. Walks every cached call graph once, accumulates per-service
/// caller endpoints (with shortest-path "via" chains) plus immediate reverse adjacency to
/// other services, and caches the result for fast lookup by <see cref="GetCallersAsync"/>.
/// </summary>
internal sealed class ReverseCallIndexService : IReverseCallIndexService
{
    private readonly ICallGraphStore _store;
    // Snapshot replaced atomically on every RebuildAsync; lookups read this reference without locking.
    private Dictionary<string, ServiceCallersDto> _cache = new(StringComparer.Ordinal);
    // impl-id → interface-id mapping built at the same time. The caller-of view treats the
    // interface as the authoritative entry (call sites dispatch through the interface, IL
    // walker records `declaringType=interface, resolvedImplType=impl`), so a lookup against
    // a concrete impl id transparently redirects to its interface entry.
    private Dictionary<string, string> _implToInterface = new(StringComparer.Ordinal);
    // Method-granular reverse map: (declaringType, methodName) → DTO. Populated in the same
    // walk as the service-level cache; keyed by "type|method" so we can use a flat dict.
    private Dictionary<string, MethodCallersDto> _methodCache = new(StringComparer.Ordinal);

    private static string MethodKey(string type, string method) => type + "|" + method;

    public ReverseCallIndexService(ICallGraphStore store)
    {
        _store = store;
    }

    public async Task RebuildAsync(CancellationToken cancellationToken = default)
    {
        var graphs = await _store.ListAsync(cancellationToken).ConfigureAwait(false);

        // Mutable accumulators per service id. Combined into immutable DTOs at the end.
        var services = new Dictionary<string, MutableEntry>(StringComparer.Ordinal);

        // Method-granular accumulator keyed by "declaringType|methodName".
        var methods = new Dictionary<string, MutableMethodEntry>(StringComparer.Ordinal);

        foreach (var graph in graphs)
        {
            // Stack mirrors the ancestor chain of *service* nodes seen on the way to the
            // current node (endpoint root excluded). Used to materialise the "via" chain
            // for each caller hit + the immediate-parent service relation.
            var ancestorServices = new List<string>(8);
            Visit(graph.RootCall, graph.EndpointId, ancestorServices, services, methods, parentNode: null, isRoot: true);
        }

        // Materialise: shortest-via wins per (service, endpoint) pair; method callers + caller-service
        // sets become read-only lists.
        var snapshot = new Dictionary<string, ServiceCallersDto>(services.Count, StringComparer.Ordinal);
        foreach (var (id, entry) in services)
        {
            var directList = entry.DirectCallers
                .Select(kv => new CallerEntry
                {
                    EndpointId = kv.Key,
                    Via = kv.Value.Via,
                    CallSites = kv.Value.CallSites,
                })
                .OrderBy(c => c.EndpointId, StringComparer.Ordinal)
                .ToList();

            var callerServiceList = entry.CallerServices
                .Select(kv =>
                {
                    services.TryGetValue(kv.Key, out var src);
                    return new CallerServiceEntry
                    {
                        Id = kv.Key,
                        ShortName = ShortName(kv.Key),
                        CalledByEndpoints = kv.Value.ToArray(),
                        FilePath = src?.FilePath,
                        LineNumber = src?.LineNumber,
                        EndLine = src?.EndLine,
                        BodySnippet = src?.BodySnippet,
                        Summary = src?.Summary,
                        MethodName = src?.MethodName,
                    };
                })
                .OrderBy(c => c.Id, StringComparer.Ordinal)
                .ToList();

            var methodCallers = entry.MethodCallers
                .ToDictionary(
                    kv => kv.Key,
                    kv => (IReadOnlyList<string>)kv.Value.OrderBy(x => x, StringComparer.Ordinal).ToList(),
                    StringComparer.Ordinal);

            snapshot[id] = new ServiceCallersDto
            {
                ServiceId = id,
                ShortName = ShortName(id),
                IsInterface = entry.IsInterface,
                ResolvedImplType = entry.ResolvedImplType,
                DirectCallers = directList,
                CallerServices = callerServiceList,
                MethodCallers = methodCallers,
                TransitiveEndpointCount = directList.Count,
            };
        }

        // Build impl→interface map alongside the snapshot. Walk every interface-flagged entry
        // and record its resolved impl so a lookup for `BrandService` can fall back to the
        // populated `IBrandService` aggregate.
        var implMap = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (id, dto) in snapshot)
        {
            if (dto.IsInterface && !string.IsNullOrEmpty(dto.ResolvedImplType))
            {
                implMap[dto.ResolvedImplType!] = id;
            }
        }

        // Method-granular snapshot.
        var methodSnapshot = new Dictionary<string, MethodCallersDto>(methods.Count, StringComparer.Ordinal);
        foreach (var (mkey, mentry) in methods)
        {
            var sep = mkey.IndexOf('|');
            var declaring = sep < 0 ? mkey : mkey[..sep];
            var methodName = sep < 0 ? "?" : mkey[(sep + 1)..];

            var sites = mentry.Sites.Values
                .Select(s => new MethodCallSite
                {
                    Ref = CallSiteRef.Format(s.CallerType, s.CallerMethod, s.LineNumber),
                    CallerType = s.CallerType,
                    CallerMethod = s.CallerMethod,
                    FilePath = s.FilePath,
                    LineNumber = s.LineNumber,
                    EndLine = s.EndLine,
                    BodySnippet = s.BodySnippet,
                    Summary = s.Summary,
                    CalledByEndpoints = s.Endpoints.OrderBy(e => e, StringComparer.Ordinal).ToArray(),
                })
                .OrderBy(s => s.Ref, StringComparer.Ordinal)
                .ToList();

            var directs = mentry.DirectCallers
                .Select(kv => new CallerEntry
                {
                    EndpointId = kv.Key,
                    Via = kv.Value.Via,
                    CallSites = kv.Value.CallSites,
                })
                .OrderBy(c => c.EndpointId, StringComparer.Ordinal)
                .ToList();

            var callees = mentry.Callees.Values
                .Select(c => new MethodCallee
                {
                    Ref = CallSiteRef.Format(c.CalleeType, c.CalleeMethod, c.LineNumber),
                    CalleeType = c.CalleeType,
                    CalleeMethod = c.CalleeMethod,
                    Kind = c.Kind,
                    ResolvedImplType = c.ResolvedImplType,
                    FilePath = c.FilePath,
                    LineNumber = c.LineNumber,
                    EndLine = c.EndLine,
                    Summary = c.Summary,
                })
                .OrderBy(c => c.Ref, StringComparer.Ordinal)
                .ToList();

            methodSnapshot[mkey] = new MethodCallersDto
            {
                DeclaringType = declaring,
                MethodName = methodName,
                ShortName = ShortName(declaring),
                CallSites = sites,
                DirectCallers = directs,
                Callees = callees,
                TotalCallSites = sites.Sum(s => s.CalledByEndpoints.Count),
                TransitiveEndpointCount = directs.Count,
            };
        }

        // Single-line swap. Concurrent readers see either the old or the new snapshot, never a partial.
        _cache = snapshot;
        _implToInterface = implMap;
        _methodCache = methodSnapshot;
    }

    public Task<ServiceCallersDto?> GetCallersAsync(string serviceId, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(serviceId)) return Task.FromResult<ServiceCallersDto?>(null);
        if (_cache.TryGetValue(serviceId, out var dto) && (dto.DirectCallers.Count > 0 || dto.CallerServices.Count > 0))
        {
            return Task.FromResult<ServiceCallersDto?>(dto);
        }
        // Concrete impl asked but call sites dispatch through the interface — redirect to it.
        if (_implToInterface.TryGetValue(serviceId, out var ifaceId)
            && _cache.TryGetValue(ifaceId, out var ifaceDto))
        {
            return Task.FromResult<ServiceCallersDto?>(ifaceDto);
        }
        return Task.FromResult(dto);
    }

    public Task<MethodCallersDto?> GetMethodCallersAsync(string declaringType, string methodName, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(declaringType) || string.IsNullOrEmpty(methodName))
        {
            return Task.FromResult<MethodCallersDto?>(null);
        }
        var key = MethodKey(declaringType, methodName);
        if (_methodCache.TryGetValue(key, out var dto)) return Task.FromResult<MethodCallersDto?>(dto);
        // Concrete impl id asked but the call sites dispatch through the interface — fall back.
        if (_implToInterface.TryGetValue(declaringType, out var ifaceId))
        {
            var ifaceKey = MethodKey(ifaceId, methodName);
            if (_methodCache.TryGetValue(ifaceKey, out var ifaceDto)) return Task.FromResult<MethodCallersDto?>(ifaceDto);
        }
        return Task.FromResult<MethodCallersDto?>(null);
    }

    private static void Visit(
        CallNode node,
        string endpointId,
        List<string> ancestorServices,
        Dictionary<string, MutableEntry> services,
        Dictionary<string, MutableMethodEntry> methods,
        CallNode? parentNode,
        bool isRoot)
    {
        // The endpoint root is the controller method itself — we treat it as the caller, not
        // a service. Recurse into its children with an empty ancestor list.
        if (!isRoot)
        {
            // Forward dep — record `node` as a callee of `parentNode` regardless of node.Kind.
            // Catches HTTP / DB / Dynamic / etc. boundaries too. Parent must itself be a named
            // method to attribute the dep to.
            RecordMethodCallee(parentNode, node, methods);

            // Accept any node that surfaces a declaringType. interface / method / controllerMethod
            // are the three kinds that carry source-level identity for reverse indexing.
            if (node.Kind is CallNodeKind.Interface or CallNodeKind.Method or CallNodeKind.ControllerMethod
                && !string.IsNullOrEmpty(node.DeclaringType))
            {
                RecordHit(node, endpointId, ancestorServices, services);
                RecordMethodHit(node, endpointId, ancestorServices, methods, parentNode);
                ancestorServices.Add(node.DeclaringType!);
            }

            // When interface dispatch resolved to a concrete impl AND the children of this
            // call are walked off the impl (which they are, by IlWalker semantics), the impl
            // type is the *next* hop and counts as an additional ancestor service for the
            // children. The impl is also recorded as its own callee entry so the user can
            // search by either name.
            if (node.Kind == CallNodeKind.Interface
                && !string.IsNullOrEmpty(node.ResolvedImplType)
                && !string.Equals(node.ResolvedImplType, node.DeclaringType, StringComparison.Ordinal))
            {
                RecordImplHit(node, endpointId, ancestorServices, services);
                ancestorServices.Add(node.ResolvedImplType!);
            }
        }

        foreach (var child in node.Calls)
        {
            Visit(child, endpointId, ancestorServices, services, methods, parentNode: node, isRoot: false);
        }

        // Pop whatever we pushed for this node so siblings start from the correct depth.
        if (!isRoot)
        {
            if (node.Kind == CallNodeKind.Interface
                && !string.IsNullOrEmpty(node.ResolvedImplType)
                && !string.Equals(node.ResolvedImplType, node.DeclaringType, StringComparison.Ordinal))
            {
                ancestorServices.RemoveAt(ancestorServices.Count - 1);
            }
            if (node.Kind is CallNodeKind.Interface or CallNodeKind.Method or CallNodeKind.ControllerMethod
                && !string.IsNullOrEmpty(node.DeclaringType))
            {
                ancestorServices.RemoveAt(ancestorServices.Count - 1);
            }
        }
    }

    private static void RecordHit(
        CallNode node,
        string endpointId,
        List<string> ancestorServices,
        Dictionary<string, MutableEntry> services)
    {
        var serviceId = node.DeclaringType!;
        if (!services.TryGetValue(serviceId, out var entry))
        {
            entry = new MutableEntry { IsInterface = node.Kind == CallNodeKind.Interface };
            services[serviceId] = entry;
        }
        entry.IsInterface = entry.IsInterface || node.Kind == CallNodeKind.Interface;
        if (entry.ResolvedImplType is null && !string.IsNullOrEmpty(node.ResolvedImplType))
        {
            entry.ResolvedImplType = node.ResolvedImplType;
        }
        // First sighting wins for source metadata — later sightings would just overwrite with
        // the same value (call-graph nodes for the same method share PDB info).
        entry.FilePath ??= node.FilePath;
        entry.LineNumber ??= node.LineNumber;
        entry.EndLine ??= node.EndLine;
        entry.BodySnippet ??= node.BodySnippet;
        entry.Summary ??= node.Summary;
        entry.MethodName ??= node.MethodName;

        // Endpoint hit + via chain (shortest wins).
        if (!entry.DirectCallers.TryGetValue(endpointId, out var hit))
        {
            entry.DirectCallers[endpointId] = new CallerAggregate
            {
                Via = ancestorServices.Count == 0
                    ? Array.Empty<string>()
                    : ancestorServices.ToArray(),
                CallSites = 1,
            };
        }
        else
        {
            hit.CallSites++;
            if (ancestorServices.Count < hit.Via.Count)
            {
                hit.Via = ancestorServices.ToArray();
            }
        }

        // Immediate-parent service → this one (reverse adjacency).
        if (ancestorServices.Count > 0)
        {
            var parentId = ancestorServices[^1];
            if (!entry.CallerServices.TryGetValue(parentId, out var set))
            {
                set = new HashSet<string>(StringComparer.Ordinal);
                entry.CallerServices[parentId] = set;
            }
            set.Add(endpointId);
        }

        // Method-level granularity.
        if (!string.IsNullOrEmpty(node.MethodName))
        {
            if (!entry.MethodCallers.TryGetValue(node.MethodName!, out var list))
            {
                list = new HashSet<string>(StringComparer.Ordinal);
                entry.MethodCallers[node.MethodName!] = list;
            }
            list.Add(endpointId);
        }
    }

    private static void RecordMethodHit(
        CallNode node,
        string endpointId,
        List<string> ancestorServices,
        Dictionary<string, MutableMethodEntry> methods,
        CallNode? parentNode)
    {
        if (string.IsNullOrEmpty(node.MethodName)) return;
        var key = MethodKey(node.DeclaringType!, node.MethodName!);
        if (!methods.TryGetValue(key, out var entry))
        {
            entry = new MutableMethodEntry();
            methods[key] = entry;
        }


        // endpoint hit + shortest via chain — mirrors the service-level aggregation.
        if (!entry.DirectCallers.TryGetValue(endpointId, out var hit))
        {
            entry.DirectCallers[endpointId] = new CallerAggregate
            {
                Via = ancestorServices.Count == 0
                    ? Array.Empty<string>()
                    : ancestorServices.ToArray(),
                CallSites = 1,
            };
        }
        else
        {
            hit.CallSites++;
            if (ancestorServices.Count < hit.Via.Count)
            {
                hit.Via = ancestorServices.ToArray();
            }
        }

        // Caller call site: when parent is the endpoint root we leave callerType as the
        // root's declaring type (controller). Endpoints surface as direct callers above so
        // skipping the synthetic root here would lose every controller→service hit.
        var callerType = parentNode?.DeclaringType;
        if (string.IsNullOrEmpty(callerType)) return;        // can't attribute — drop
        var callerMethod = parentNode?.MethodName;
        var siteKey = callerType + "|" + (callerMethod ?? "?") + "|" + (parentNode?.LineNumber?.ToString() ?? "?");
        if (!entry.Sites.TryGetValue(siteKey, out var site))
        {
            site = new MutableMethodCallSite
            {
                CallerType = callerType,
                CallerMethod = callerMethod,
                FilePath = parentNode?.FilePath,
                LineNumber = parentNode?.LineNumber,
                EndLine = parentNode?.EndLine,
                BodySnippet = parentNode?.BodySnippet,
                Summary = parentNode?.Summary,
            };
            entry.Sites[siteKey] = site;
        }
        site.Endpoints.Add(endpointId);
    }

    private static void RecordMethodCallee(
        CallNode? parentNode,
        CallNode child,
        Dictionary<string, MutableMethodEntry> methods)
    {
        if (parentNode is null
            || string.IsNullOrEmpty(parentNode.DeclaringType)
            || string.IsNullOrEmpty(parentNode.MethodName))
        {
            return;
        }
        // Filter noise — DTO / view-model carriers, property accessors, operator overloads,
        // ctors. They're not function:function dependencies; surfacing them just hides the
        // real wiring (Service.Foo → IPriceListService.GetX).
        if (IsNoiseCallee(child)) return;
        var parentKey = MethodKey(parentNode.DeclaringType!, parentNode.MethodName!);
        if (!methods.TryGetValue(parentKey, out var parentEntry))
        {
            parentEntry = new MutableMethodEntry();
            methods[parentKey] = parentEntry;
        }
        var calleeKey = (child.DeclaringType ?? "?") + "|"
            + (child.MethodName ?? child.DisplayName ?? "?") + "|"
            + (child.LineNumber?.ToString() ?? "?");
        if (parentEntry.Callees.ContainsKey(calleeKey)) return;
        parentEntry.Callees[calleeKey] = new MutableMethodCallee
        {
            CalleeType = child.DeclaringType ?? "?",
            CalleeMethod = child.MethodName ?? child.DisplayName,
            Kind = child.Kind.ToString(),
            ResolvedImplType = child.ResolvedImplType,
            FilePath = child.FilePath,
            LineNumber = child.LineNumber,
            EndLine = child.EndLine,
            Summary = child.Summary,
        };
    }

    private static void RecordImplHit(
        CallNode node,
        string endpointId,
        List<string> ancestorServices,
        Dictionary<string, MutableEntry> services)
    {
        // Treat the resolved impl as a synthetic service entry that piggy-backs on the
        // same metadata as the interface — the user expects to find UserService when they
        // search for IUserService and vice versa.
        var implId = node.ResolvedImplType!;
        if (!services.TryGetValue(implId, out var entry))
        {
            entry = new MutableEntry { IsInterface = false };
            services[implId] = entry;
        }
        entry.FilePath ??= node.FilePath;
        entry.LineNumber ??= node.LineNumber;
        entry.EndLine ??= node.EndLine;
        entry.BodySnippet ??= node.BodySnippet;
        entry.Summary ??= node.Summary;
        entry.MethodName ??= node.MethodName;
        if (!entry.DirectCallers.TryGetValue(endpointId, out var hit))
        {
            entry.DirectCallers[endpointId] = new CallerAggregate
            {
                Via = ancestorServices.Count == 0
                    ? Array.Empty<string>()
                    : ancestorServices.ToArray(),
                CallSites = 1,
            };
        }
        else
        {
            hit.CallSites++;
        }
        if (ancestorServices.Count > 0)
        {
            var parentId = ancestorServices[^1];
            if (!entry.CallerServices.TryGetValue(parentId, out var set))
            {
                set = new HashSet<string>(StringComparer.Ordinal);
                entry.CallerServices[parentId] = set;
            }
            set.Add(endpointId);
        }
    }

    private static bool IsNoiseCallee(CallNode c)
    {
        // Data carriers (DTOs / view-models / requests / responses / entities / models)
        // don't represent function:function dependencies — their property accessors and
        // ctors flood the list. Reuse the same heuristic the service map uses.
        if (!string.IsNullOrEmpty(c.DeclaringType) && ServiceMapBuilder.IsDataCarrierType(c.DeclaringType!))
        {
            return true;
        }
        // Accessors / operators / ctors collapse to property/operator semantics — not real
        // call sites for refactoring. Skip them across all types so log/event classes etc.
        // don't pollute the dep list either.
        var m = c.MethodName;
        if (string.IsNullOrEmpty(m)) return false;
        if (m.StartsWith("get_", StringComparison.Ordinal)) return true;
        if (m.StartsWith("set_", StringComparison.Ordinal)) return true;
        if (m.StartsWith("op_", StringComparison.Ordinal)) return true;
        if (m == ".ctor" || m == ".cctor") return true;
        return false;
    }

    private static string ShortName(string fullName)
    {
        if (string.IsNullOrEmpty(fullName)) return fullName;
        var dot = fullName.LastIndexOf('.');
        return dot >= 0 ? fullName[(dot + 1)..] : fullName;
    }

    private sealed class MutableEntry
    {
        public bool IsInterface;
        public string? ResolvedImplType;
        public string? FilePath;
        public int? LineNumber;
        public int? EndLine;
        public string? BodySnippet;
        public string? Summary;
        public string? MethodName;
        public Dictionary<string, CallerAggregate> DirectCallers { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, HashSet<string>> CallerServices { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, HashSet<string>> MethodCallers { get; } = new(StringComparer.Ordinal);
    }

    private sealed class CallerAggregate
    {
        public IReadOnlyList<string> Via { get; set; } = Array.Empty<string>();
        public int CallSites { get; set; }
    }

    // Method-granular accumulator. One per (declaringType, methodName) seen as a callee.
    private sealed class MutableMethodEntry
    {
        // dedupe by callerType + callerMethod + line so the same source line collapses across walks.
        public Dictionary<string, MutableMethodCallSite> Sites { get; } = new(StringComparer.Ordinal);
        // endpointId → shortest via chain
        public Dictionary<string, CallerAggregate> DirectCallers { get; } = new(StringComparer.Ordinal);
        // Forward deps — methods invoked inside this method's body. Dedupe per
        // (calleeType, calleeMethod, line) so siblings don't collapse but identical sites do.
        public Dictionary<string, MutableMethodCallee> Callees { get; } = new(StringComparer.Ordinal);
    }

    private sealed class MutableMethodCallee
    {
        public required string CalleeType;
        public string? CalleeMethod;
        public required string Kind;
        public string? ResolvedImplType;
        public string? FilePath;
        public int? LineNumber;
        public int? EndLine;
        public string? Summary;
    }

    private sealed class MutableMethodCallSite
    {
        public required string CallerType;
        public string? CallerMethod;
        public string? FilePath;
        public int? LineNumber;
        public int? EndLine;
        public string? BodySnippet;
        public string? Summary;
        public HashSet<string> Endpoints { get; } = new(StringComparer.Ordinal);
    }
}
