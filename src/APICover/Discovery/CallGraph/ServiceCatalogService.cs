using APICover.Abstractions.Discovery;
using APICover.Abstractions.Services;

namespace APICover.Discovery.CallGraph;

/// <summary>
/// Default <see cref="IServiceCatalogService"/> implementation. Walks every persisted
/// <see cref="CallGraphNode"/> in the store and produces a flattened list of services with
/// usage counts, plus external HTTP / DB boundary leaderboards. No IL walking — pure
/// aggregation over already-built trees, so it's safe to call repeatedly.
/// </summary>
internal sealed class ServiceCatalogService : IServiceCatalogService
{
    private readonly ICallGraphStore _store;

    public ServiceCatalogService(ICallGraphStore store) { _store = store; }

    public async Task<ServiceCatalog> BuildAsync(CancellationToken cancellationToken = default)
    {
        var graphs = await _store.ListAsync(cancellationToken).ConfigureAwait(false);

        // declaringType → entry
        var services = new Dictionary<string, MutableEntry>(StringComparer.Ordinal);
        var externals = new Dictionary<string, MutableBoundary>(StringComparer.Ordinal);
        var databases = new Dictionary<string, MutableBoundary>(StringComparer.Ordinal);

        foreach (var g in graphs)
        {
            VisitNode(g.RootCall, g.EndpointId, services, externals, databases, isRoot: true);
        }

        var serviceList = services.Values
            .Select(m => new ServiceUsageEntry
            {
                DeclaringType = m.DeclaringType,
                ShortName = ShortName(m.DeclaringType),
                IsInterface = m.IsInterface,
                ResolvedImplType = m.ResolvedImplType,
                UsedByEndpoints = m.Endpoints.OrderBy(s => s, StringComparer.Ordinal).ToList(),
                CalledMethods = m.Methods.OrderBy(s => s, StringComparer.Ordinal).ToList(),
                TotalCallSites = m.TotalCallSites,
            })
            .OrderByDescending(s => s.UsedByEndpoints.Count)
            .ThenBy(s => s.ShortName, StringComparer.Ordinal)
            .ToList();

        return new ServiceCatalog
        {
            GeneratedAt = DateTimeOffset.UtcNow,
            Services = serviceList,
            ExternalHttp = ToBoundaryList(externals, "ExternalHttp"),
            Databases = ToBoundaryList(databases, "Database"),
        };
    }

    private static void VisitNode(
        CallNode node,
        string endpointId,
        Dictionary<string, MutableEntry> services,
        Dictionary<string, MutableBoundary> externals,
        Dictionary<string, MutableBoundary> databases,
        bool isRoot)
    {
        // Track interface + concrete-impl call sites (skip the endpoint root itself).
        if (!isRoot && node.DeclaringType is { Length: > 0 } declaring)
        {
            switch (node.Kind)
            {
                case CallNodeKind.Interface:
                {
                    var entry = services.TryGetValue(declaring, out var existing)
                        ? existing
                        : services[declaring] = new MutableEntry(declaring, isInterface: true);
                    entry.Endpoints.Add(endpointId);
                    if (node.MethodName is { Length: > 0 }) entry.Methods.Add(node.MethodName);
                    if (node.ResolvedImplType is { Length: > 0 }) entry.ResolvedImplType ??= node.ResolvedImplType;
                    entry.TotalCallSites++;
                    break;
                }
                case CallNodeKind.Method:
                {
                    // Concrete user-code methods — index the declaring type as a "service" too
                    // so non-interface utility classes show up in the catalog. Skip property
                    // accessors and constructors which would dominate noise.
                    var name = node.MethodName ?? "";
                    if (name == ".ctor" || name == ".cctor") break;
                    if (name.StartsWith("get_", StringComparison.Ordinal) || name.StartsWith("set_", StringComparison.Ordinal)) break;
                    if (name.StartsWith("add_", StringComparison.Ordinal) || name.StartsWith("remove_", StringComparison.Ordinal)) break;
                    var entry = services.TryGetValue(declaring, out var existing)
                        ? existing
                        : services[declaring] = new MutableEntry(declaring, isInterface: false);
                    entry.Endpoints.Add(endpointId);
                    entry.Methods.Add(name);
                    entry.TotalCallSites++;
                    break;
                }
                case CallNodeKind.ExternalHttp:
                {
                    // Prefer the captured URL (in Notes "→ https://…") for the bucket key;
                    // fall back to declaring type + method when no URL was extractable.
                    var label = ExtractUrlFromNotes(node.Notes) ?? $"{declaring}.{node.MethodName}";
                    var b = externals.TryGetValue(label, out var existing)
                        ? existing
                        : externals[label] = new MutableBoundary(label);
                    b.Endpoints.Add(endpointId);
                    b.TotalCallSites++;
                    break;
                }
                case CallNodeKind.Database:
                {
                    var label = $"{declaring}.{node.MethodName}";
                    var b = databases.TryGetValue(label, out var existing)
                        ? existing
                        : databases[label] = new MutableBoundary(label);
                    b.Endpoints.Add(endpointId);
                    b.TotalCallSites++;
                    break;
                }
            }
        }

        foreach (var c in node.Calls) VisitNode(c, endpointId, services, externals, databases, isRoot: false);
    }

    private static IReadOnlyList<ExternalBoundary> ToBoundaryList(Dictionary<string, MutableBoundary> map, string kind) =>
        map.Values
            .Select(m => new ExternalBoundary
            {
                Label = m.Label,
                Kind = kind,
                UsedByEndpoints = m.Endpoints.OrderBy(s => s, StringComparer.Ordinal).ToList(),
                TotalCallSites = m.TotalCallSites,
            })
            .OrderByDescending(b => b.UsedByEndpoints.Count)
            .ThenBy(b => b.Label, StringComparer.Ordinal)
            .ToList();

    private static string? ExtractUrlFromNotes(string? notes)
    {
        if (string.IsNullOrEmpty(notes)) return null;
        // Walker stashes URLs as "→ https://…" — peel that prefix.
        const string prefix = "→ ";
        return notes.StartsWith(prefix, StringComparison.Ordinal) ? notes.Substring(prefix.Length) : null;
    }

    private static string ShortName(string fullName)
    {
        var dot = fullName.LastIndexOf('.');
        return dot < 0 ? fullName : fullName.Substring(dot + 1);
    }

    private sealed class MutableEntry
    {
        public string DeclaringType { get; }
        public bool IsInterface { get; }
        public string? ResolvedImplType { get; set; }
        public HashSet<string> Endpoints { get; } = new(StringComparer.Ordinal);
        public HashSet<string> Methods { get; } = new(StringComparer.Ordinal);
        public int TotalCallSites { get; set; }

        public MutableEntry(string declaringType, bool isInterface)
        {
            DeclaringType = declaringType;
            IsInterface = isInterface;
        }
    }

    private sealed class MutableBoundary
    {
        public string Label { get; }
        public HashSet<string> Endpoints { get; } = new(StringComparer.Ordinal);
        public int TotalCallSites { get; set; }
        public MutableBoundary(string label) { Label = label; }
    }
}
