using APICover.Abstractions.Discovery;
using APICover.Abstractions.Services;
using APICover.Endpoints;
using Microsoft.Extensions.Hosting;

namespace APICover.Discovery.CallGraph;

/// <summary>
/// LLM-facing projection of <see cref="ServiceMap.Communities"/>. Two granularities:
/// an overview (table of contents — which domains exist, how risky, how connected)
/// and a per-community context chunk sized to fit one model call even when the host
/// has hundreds of endpoints. This is the substrate for map-reduce system
/// understanding: one agent pass per community, then a reduce pass over the cards.
/// </summary>
public interface ICommunityContextService
{
    Task<object> GetOverviewAsync(CancellationToken cancellationToken = default);
    Task<object?> GetCommunityContextAsync(int index, CancellationToken cancellationToken = default);

    /// <summary>Which communities are touched by code changed since <paramref name="sinceSha"/>?
    /// Enables incremental understanding: re-scan only dirty cards instead of the whole host.</summary>
    Task<object> GetDirtyCommunitiesAsync(string sinceSha, CancellationToken cancellationToken = default);
}

internal sealed class CommunityContextService : ICommunityContextService
{
    private readonly IServiceMapService _mapService;
    private readonly IEndpointDiscoveryService _discovery;
    private readonly ICallGraphStore? _callGraphs;
    private readonly IHostEnvironment? _env;

    public CommunityContextService(
        IServiceMapService mapService,
        IEndpointDiscoveryService discovery,
        ICallGraphStore? callGraphs = null,
        IHostEnvironment? env = null)
    {
        _mapService = mapService;
        _discovery = discovery;
        _callGraphs = callGraphs;
        _env = env;
    }

    public async Task<object> GetOverviewAsync(CancellationToken cancellationToken = default)
    {
        var map = await _mapService.BuildAsync(cancellationToken).ConfigureAwait(false);
        var nodesById = map.Nodes.ToDictionary(n => n.Id, StringComparer.Ordinal);

        var communities = map.Communities.Select(c =>
        {
            var members = c.NodeIds.Where(nodesById.ContainsKey).Select(id => nodesById[id]).ToList();
            var endpoints = members.Where(n => n.Kind == ServiceMapNodeKind.Endpoint).ToList();
            return new
            {
                index = c.Index,
                label = c.Label,
                riskScore = c.RiskScore,
                endpointCount = c.EndpointCount,
                serviceCount = members.Count(n => n.Kind == ServiceMapNodeKind.Service),
                boundaryCount = members.Count(n => n.Kind is ServiceMapNodeKind.Database or ServiceMapNodeKind.ExternalHttp),
                topEndpoints = endpoints
                    .OrderByDescending(n => n.Metrics.Risk)
                    .Take(5)
                    .Select(n => new { id = n.Id, risk = n.Metrics.Risk })
                    .ToArray(),
                connectsTo = CrossCommunityLinks(map, nodesById, c).Select(l => new
                {
                    communityIndex = l.TargetIndex,
                    label = l.TargetLabel,
                    sharedEdges = l.EdgeCount,
                }).ToArray(),
            };
        }).ToArray();

        return new
        {
            generatedAt = map.GeneratedAt,
            // Stamp into system.md so a later run can ask get_dirty_communities(sinceSha)
            // and re-scan only what changed.
            headSha = _env is null ? null : GitLog.HeadSha(_env.ContentRootPath),
            totalEndpoints = map.Nodes.Count(n => n.Kind == ServiceMapNodeKind.Endpoint),
            totalCommunities = map.Communities.Count,
            hint = "Communities are risk-ordered: index 0 deserves attention first. "
                 + "Cross-community links are where integrated UI journeys live — flows that "
                 + "span two communities (e.g. users → billing) are prime scenario candidates.",
            communities,
        };
    }

    public async Task<object?> GetCommunityContextAsync(int index, CancellationToken cancellationToken = default)
    {
        var map = await _mapService.BuildAsync(cancellationToken).ConfigureAwait(false);
        var community = map.Communities.FirstOrDefault(c => c.Index == index);
        if (community is null) return null;

        var nodesById = map.Nodes.ToDictionary(n => n.Id, StringComparer.Ordinal);
        var endpointsById = _discovery.GetEndpoints().ToDictionary(e => e.Id, StringComparer.Ordinal);
        var members = community.NodeIds.Where(nodesById.ContainsKey).Select(id => nodesById[id]).ToList();

        // Directed adjacency for downstream walks (app root excluded — layout anchor).
        var outgoing = map.Edges
            .Where(e => e.From != "app:host" && e.To != "app:host")
            .GroupBy(e => e.From, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => g.ToList(), StringComparer.Ordinal);

        var endpoints = members
            .Where(n => n.Kind == ServiceMapNodeKind.Endpoint)
            .OrderByDescending(n => n.Metrics.Risk)
            .Select(n =>
            {
                var reach = WalkDownstream(n.Id, outgoing, nodesById);
                endpointsById.TryGetValue(n.Id, out var descriptor);
                return new
                {
                    id = n.Id,
                    area = n.Area,
                    purpose = descriptor?.Purpose,
                    displayName = descriptor?.DisplayName,
                    risk = n.Metrics.Risk,
                    coupling = n.Metrics.Coupling,
                    // Condensed dependency chain — services then boundaries. Enough for
                    // flow reasoning; call endpoints.details for schemas when authoring.
                    services = reach.Services,
                    boundaries = reach.Boundaries,
                };
            })
            .ToArray();

        var services = members
            .Where(n => n.Kind == ServiceMapNodeKind.Service)
            .OrderByDescending(n => n.Metrics.Risk)
            .Select(n => new
            {
                id = n.Id,
                label = n.Label,
                isInterface = n.IsInterface,
                resolvedImpl = n.ResolvedImplType,
                fanIn = n.Metrics.FanIn,
                risk = n.Metrics.Risk,
            })
            .ToArray();

        var boundaries = members
            .Where(n => n.Kind is ServiceMapNodeKind.Database or ServiceMapNodeKind.ExternalHttp)
            .Select(n => new { id = n.Id, kind = n.Kind.ToString(), label = n.Label })
            .ToArray();

        var links = CrossCommunityLinks(map, nodesById, community).Select(l => new
        {
            communityIndex = l.TargetIndex,
            label = l.TargetLabel,
            sharedEdges = l.EdgeCount,
            viaNodes = l.ViaNodes,
        }).ToArray();

        return new
        {
            index = community.Index,
            label = community.Label,
            riskScore = community.RiskScore,
            endpointCount = community.EndpointCount,
            endpoints,
            services,
            boundaries,
            crossCommunity = links,
            hint = "Endpoints are risk-ordered. Shared services between endpoints imply "
                 + "shared state — mutations through one endpoint are observable through "
                 + "its siblings. Cross-community links are integration-flow seams.",
        };
    }

    public async Task<object> GetDirtyCommunitiesAsync(string sinceSha, CancellationToken cancellationToken = default)
    {
        if (_callGraphs is null || _env is null)
        {
            return new { error = "Dirty-community tracking unavailable — call graph store or host environment not registered." };
        }
        if (string.IsNullOrWhiteSpace(sinceSha))
        {
            return new { error = "Required field 'sinceSha' is missing. Read it from system.md (headSha of the last scan)." };
        }

        var root = _env.ContentRootPath;
        var headSha = GitLog.HeadSha(root);
        var changed = GitLog.ChangedFiles(root, sinceSha.Trim());
        if (changed is null)
        {
            return new { error = $"git diff failed for '{sinceSha}' — bad sha or not a git repo. Fall back to a full scan." };
        }
        if (changed.Count == 0)
        {
            return new { sinceSha, headSha, changedFileCount = 0, dirtyCommunities = Array.Empty<object>(), hint = "Nothing changed — memory cards are current." };
        }

        var changedNormalized = changed.Select(NormalizePath).ToList();
        var map = await _mapService.BuildAsync(cancellationToken).ConfigureAwait(false);
        var nodesById = map.Nodes.ToDictionary(n => n.Id, StringComparer.Ordinal);
        var graphs = await _callGraphs.ListAsync(cancellationToken).ConfigureAwait(false);

        var matchedFiles = new HashSet<string>(StringComparer.Ordinal);
        var dirtyByCommunity = new Dictionary<int, (HashSet<string> Endpoints, HashSet<string> Files)>();
        foreach (var graph in graphs)
        {
            var files = new HashSet<string>(StringComparer.Ordinal);
            CollectFilePaths(graph.RootCall, files);
            var hits = changedNormalized
                .Where(cf => files.Any(f => PathMatches(f, cf)))
                .ToList();
            if (hits.Count == 0) continue;
            foreach (var h in hits) matchedFiles.Add(h);
            if (!nodesById.TryGetValue(graph.EndpointId, out var node) || node.CommunityIndex < 0) continue;
            if (!dirtyByCommunity.TryGetValue(node.CommunityIndex, out var acc))
            {
                acc = (new HashSet<string>(StringComparer.Ordinal), new HashSet<string>(StringComparer.Ordinal));
                dirtyByCommunity[node.CommunityIndex] = acc;
            }
            acc.Endpoints.Add(graph.EndpointId);
            foreach (var h in hits) acc.Files.Add(h);
        }

        var dirty = dirtyByCommunity
            .OrderBy(kv => kv.Key)
            .Select(kv =>
            {
                var community = map.Communities.FirstOrDefault(c => c.Index == kv.Key);
                return new
                {
                    index = kv.Key,
                    label = community?.Label ?? $"community-{kv.Key}",
                    riskScore = community?.RiskScore ?? 0,
                    dirtyEndpoints = kv.Value.Endpoints.OrderBy(s => s, StringComparer.Ordinal).ToArray(),
                    changedFiles = kv.Value.Files.OrderBy(s => s, StringComparer.Ordinal).ToArray(),
                };
            })
            .ToArray();

        var unmatched = changedNormalized.Where(cf => !matchedFiles.Contains(cf)).ToArray();
        return new
        {
            sinceSha,
            headSha,
            changedFileCount = changed.Count,
            dirtyCommunities = dirty,
            cleanCommunityCount = map.Communities.Count - dirty.Length,
            unmatchedChangedFiles = unmatched,
            hint = dirty.Length == 0
                ? "Changes touched no endpoint call graph (infra/docs/config). Cards likely current; re-scan only if unmatched files include startup/routing code."
                : "Re-scan ONLY the dirty communities' cards, then refresh system.md with the new headSha. Unmatched files that affect startup/DI may still warrant a full scan.",
        };
    }

    private static void CollectFilePaths(CallNode node, HashSet<string> files)
    {
        if (!string.IsNullOrEmpty(node.FilePath)) files.Add(NormalizePath(node.FilePath));
        foreach (var c in node.Calls) CollectFilePaths(c, files);
    }

    private static string NormalizePath(string path) => path.Replace('\\', '/');

    /// <summary>Suffix match with a segment boundary: an absolute PDB path matches the
    /// repo-relative git path when it ends with it at a '/' boundary.</summary>
    private static bool PathMatches(string absoluteOrLonger, string repoRelative)
    {
        if (absoluteOrLonger.Length < repoRelative.Length) return false;
        if (!absoluteOrLonger.EndsWith(repoRelative, StringComparison.Ordinal)) return false;
        var idx = absoluteOrLonger.Length - repoRelative.Length;
        return idx == 0 || absoluteOrLonger[idx - 1] == '/';
    }

    private static (List<string> Services, List<string> Boundaries) WalkDownstream(
        string startId,
        Dictionary<string, List<ServiceMapEdge>> outgoing,
        Dictionary<string, ServiceMapNode> nodesById)
    {
        var services = new List<string>();
        var boundaries = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal) { startId };
        var stack = new Stack<string>();
        stack.Push(startId);
        while (stack.Count > 0)
        {
            var id = stack.Pop();
            if (!outgoing.TryGetValue(id, out var edges)) continue;
            foreach (var e in edges)
            {
                if (!seen.Add(e.To)) continue;
                if (!nodesById.TryGetValue(e.To, out var node)) continue;
                switch (node.Kind)
                {
                    case ServiceMapNodeKind.Service:
                        services.Add(node.Label);
                        stack.Push(e.To);
                        break;
                    case ServiceMapNodeKind.Database:
                    case ServiceMapNodeKind.ExternalHttp:
                        boundaries.Add($"{(node.Kind == ServiceMapNodeKind.Database ? "db" : "http")}:{node.Label}");
                        break;
                }
            }
        }
        return (services, boundaries);
    }

    private static IEnumerable<(int TargetIndex, string TargetLabel, int EdgeCount, string[] ViaNodes)> CrossCommunityLinks(
        ServiceMap map,
        Dictionary<string, ServiceMapNode> nodesById,
        ServiceMapCommunity community)
    {
        var memberIds = new HashSet<string>(community.NodeIds, StringComparer.Ordinal);
        var byTarget = new Dictionary<int, (int Count, HashSet<string> Via)>();
        foreach (var e in map.Edges)
        {
            if (e.From == "app:host" || e.To == "app:host") continue;
            var fromIn = memberIds.Contains(e.From);
            var toIn = memberIds.Contains(e.To);
            if (fromIn == toIn) continue;
            var outsideId = fromIn ? e.To : e.From;
            if (!nodesById.TryGetValue(outsideId, out var outside) || outside.CommunityIndex < 0) continue;
            if (!byTarget.TryGetValue(outside.CommunityIndex, out var acc))
            {
                acc = (0, new HashSet<string>(StringComparer.Ordinal));
            }
            acc.Via.Add(outsideId);
            byTarget[outside.CommunityIndex] = (acc.Count + 1, acc.Via);
        }
        foreach (var (targetIndex, (count, via)) in byTarget.OrderByDescending(kv => kv.Value.Count))
        {
            var label = map.Communities.FirstOrDefault(c => c.Index == targetIndex)?.Label ?? $"community-{targetIndex}";
            yield return (targetIndex, label, count, via.OrderBy(s => s, StringComparer.Ordinal).Take(8).ToArray());
        }
    }
}
