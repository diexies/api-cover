using System.Text.Json;
using System.Text.Json.Nodes;
using APICover.Abstractions.Discovery;
using APICover.Abstractions.Services;
using APICover.Discovery.CallGraph;

namespace APICover.Tests;

public class CommunityContextServiceTests
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    [Fact]
    public async Task Overview_ListsRiskOrderedCommunities_WithSeams()
    {
        var svc = await BuildService(SeamedGraphs());
        var overview = ToJson(await svc.GetOverviewAsync());

        Assert.True(overview["totalCommunities"]!.GetValue<int>() >= 2,
            $"expected >= 2 communities, payload: {overview["communities"]!.ToJsonString()}");
        Assert.Equal(6, overview["totalEndpoints"]!.GetValue<int>());

        var communities = overview["communities"]!.AsArray();
        var risks = communities.Select(c => c!["riskScore"]!.GetValue<double>()).ToList();
        Assert.Equal(risks.OrderByDescending(r => r).ToList(), risks);

        // The billing→users seam must surface on at least one side, unless propagation
        // merged both clusters (then there is a single community and no seam to report).
        if (communities.Count > 1)
        {
            var hasSeam = communities.Any(c => c!["connectsTo"]!.AsArray().Count > 0);
            Assert.True(hasSeam, "expected at least one cross-community link");
        }
    }

    [Fact]
    public async Task CommunityContext_CarriesDependencyChains()
    {
        var svc = await BuildService(SeamedGraphs());
        var overview = ToJson(await svc.GetOverviewAsync());
        var billingIndex = overview["communities"]!.AsArray()
            .First(c => c!["label"]!.GetValue<string>() == "billing")!["index"]!.GetValue<int>();

        var ctx = ToJson((await svc.GetCommunityContextAsync(billingIndex))!);

        Assert.Equal("billing", ctx["label"]!.GetValue<string>());
        var endpoints = ctx["endpoints"]!.AsArray();
        Assert.True(endpoints.Count >= 3);

        var pay = endpoints.First(e => e!["id"]!.GetValue<string>() == "POST /billing/pay")!;
        var services = pay["services"]!.AsArray().Select(s => s!.GetValue<string>()).ToList();
        Assert.Contains("IBillingSvc", services);
        var boundaries = pay["boundaries"]!.AsArray().Select(s => s!.GetValue<string>()).ToList();
        Assert.Contains(boundaries, b => b.StartsWith("db:"));

        // Risk ordering inside the community.
        var risks = endpoints.Select(e => e!["risk"]!.GetValue<double>()).ToList();
        Assert.Equal(risks.OrderByDescending(r => r).ToList(), risks);
    }

    [Fact]
    public async Task CommunityContext_UnknownIndex_ReturnsNull()
    {
        var svc = await BuildService(SeamedGraphs());
        Assert.Null(await svc.GetCommunityContextAsync(999));
    }

    /* ─── fixture ───────────────────────────────────────────────────────── */

    // users cluster (3 eps, svc+repo) and billing cluster (3 eps, svc+repo+db),
    // seamed by IBillingSvc → IUserSvc.
    private static IReadOnlyList<CallGraphNode> SeamedGraphs() => new[]
    {
        Graph("GET /users",        root => root.Add(Call(CallNodeKind.Interface, "Demo.IUserSvc", "List",
            c => c.Add(Call(CallNodeKind.Interface, "Demo.IUserRepo", "All"))))),
        Graph("POST /users",       root => root.Add(Call(CallNodeKind.Interface, "Demo.IUserSvc", "Create"))),
        Graph("GET /users/{id}",   root => root.Add(Call(CallNodeKind.Interface, "Demo.IUserSvc", "Get"))),
        Graph("GET /billing",      root => root.Add(Call(CallNodeKind.Interface, "Demo.IBillingSvc", "List"))),
        Graph("GET /billing/{id}", root => root.Add(Call(CallNodeKind.Interface, "Demo.IBillingSvc", "Get"))),
        Graph("POST /billing/pay", root => root.Add(Call(CallNodeKind.Interface, "Demo.IBillingSvc", "Pay", c =>
        {
            c.Add(Call(CallNodeKind.Interface, "Demo.IBillingRepo", "Save",
                cc => cc.Add(Call(CallNodeKind.Database, "Demo.Db", "SaveChanges"))));
            c.Add(Call(CallNodeKind.Interface, "Demo.IUserSvc", "Get"));
        }))),
    };

    private static async Task<CommunityContextService> BuildService(IReadOnlyList<CallGraphNode> graphs)
    {
        var store = new Store();
        foreach (var g in graphs) await store.SaveAsync(g);
        var discovery = new Discovery(graphs
            .Select(g => new EndpointDescriptor
            {
                Id = g.EndpointId,
                Method = g.EndpointId.Split(' ')[0],
                Path = g.EndpointId.Split(' ')[1],
            })
            .ToList());
        return new CommunityContextService(new ServiceMapBuilder(store, discovery), discovery);
    }

    private static JsonNode ToJson(object o) => JsonSerializer.SerializeToNode(o, Json)!;

    private static CallGraphNode Graph(string endpointId, Action<List<CallNode>> configure)
    {
        var children = new List<CallNode>();
        configure(children);
        return new CallGraphNode
        {
            EndpointId = endpointId,
            RootMethod = endpointId,
            GeneratedAt = DateTimeOffset.UtcNow,
            AssemblyHash = "test",
            RootCall = new CallNode { DisplayName = endpointId, Kind = CallNodeKind.ControllerMethod, Calls = children },
        };
    }

    private static CallNode Call(CallNodeKind kind, string type, string method, Action<List<CallNode>>? configure = null)
    {
        var children = new List<CallNode>();
        configure?.Invoke(children);
        return new CallNode
        {
            DisplayName = $"{type}.{method}",
            DeclaringType = type,
            MethodName = method,
            Kind = kind,
            Calls = children,
        };
    }

    private sealed class Discovery : IEndpointDiscoveryService
    {
        private readonly IReadOnlyList<EndpointDescriptor> _eps;
        public Discovery(IReadOnlyList<EndpointDescriptor> eps) { _eps = eps; }
        public IReadOnlyList<EndpointDescriptor> GetEndpoints() => _eps;
    }

    private sealed class Store : ICallGraphStore
    {
        private readonly Dictionary<string, CallGraphNode> _byId = new(StringComparer.Ordinal);
        public Task<CallGraphNode?> GetAsync(string endpointId, CancellationToken ct = default)
            => Task.FromResult(_byId.GetValueOrDefault(endpointId));
        public Task SaveAsync(CallGraphNode graph, CancellationToken ct = default)
        {
            _byId[graph.EndpointId] = graph;
            return Task.CompletedTask;
        }
        public Task<IReadOnlyList<CallGraphNode>> ListAsync(CancellationToken ct = default)
            => Task.FromResult<IReadOnlyList<CallGraphNode>>(_byId.Values.ToList());
        public Task DeleteAllAsync(CancellationToken ct = default)
        {
            _byId.Clear();
            return Task.CompletedTask;
        }
    }
}
