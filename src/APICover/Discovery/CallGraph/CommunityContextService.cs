using APICover.Abstractions.Discovery;
using APICover.Abstractions.Services;

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
}

internal sealed class CommunityContextService : ICommunityContextService
{
    private readonly IServiceMapService _mapService;
    private readonly IEndpointDiscoveryService _discovery;

    public CommunityContextService(IServiceMapService mapService, IEndpointDiscoveryService discovery)
    {
        _mapService = mapService;
        _discovery = discovery;
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
