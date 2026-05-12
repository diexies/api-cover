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

    public ReverseCallIndexService(ICallGraphStore store)
    {
        _store = store;
    }

    public async Task RebuildAsync(CancellationToken cancellationToken = default)
    {
        var graphs = await _store.ListAsync(cancellationToken).ConfigureAwait(false);

        // Mutable accumulators per service id. Combined into immutable DTOs at the end.
        var services = new Dictionary<string, MutableEntry>(StringComparer.Ordinal);

        foreach (var graph in graphs)
        {
            // Stack mirrors the ancestor chain of *service* nodes seen on the way to the
            // current node (endpoint root excluded). Used to materialise the "via" chain
            // for each caller hit + the immediate-parent service relation.
            var ancestorServices = new List<string>(8);
            Visit(graph.RootCall, graph.EndpointId, ancestorServices, services, isRoot: true);
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

        // Single-line swap. Concurrent readers see either the old or the new snapshot, never a partial.
        _cache = snapshot;
        _implToInterface = implMap;
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

    private static void Visit(
        CallNode node,
        string endpointId,
        List<string> ancestorServices,
        Dictionary<string, MutableEntry> services,
        bool isRoot)
    {
        // The endpoint root is the controller method itself — we treat it as the caller, not
        // a service. Recurse into its children with an empty ancestor list.
        if (!isRoot)
        {
            // Accept any node that surfaces a declaringType. interface / method / controllerMethod
            // are the three kinds that carry source-level identity for reverse indexing.
            if (node.Kind is CallNodeKind.Interface or CallNodeKind.Method or CallNodeKind.ControllerMethod
                && !string.IsNullOrEmpty(node.DeclaringType))
            {
                RecordHit(node, endpointId, ancestorServices, services);
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
            Visit(child, endpointId, ancestorServices, services, isRoot: false);
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
}
