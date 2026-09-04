using APICover.Abstractions.Discovery;
using APICover.Abstractions.Services;
using APICover.Discovery.CallGraph;

namespace APICover.Tests;

public class ServiceMapBuilderTests
{
    [Fact]
    public async Task BuildsNodesAndEdges_ForSimpleEndpointToService()
    {
        // POST /invoices → InvoiceService → InvoiceRepository → DbContext.SaveChanges
        var graph = MakeGraph("POST /invoices", root =>
            root.Add(MakeCall(CallNodeKind.Interface, "Demo.IInvoiceService", "Create", calls =>
            {
                calls.Add(MakeCall(CallNodeKind.Interface, "Demo.IInvoiceRepository", "Save", inner =>
                {
                    inner.Add(MakeCall(CallNodeKind.Database, "Demo.AppDbContext", "SaveChangesAsync"));
                }));
            })));

        var map = await BuildMap(new[] { graph });

        Assert.Contains(map.Nodes, n => n.Id == "POST /invoices" && n.Kind == ServiceMapNodeKind.Endpoint);
        Assert.Contains(map.Nodes, n => n.Id == "Demo.IInvoiceService" && n.Kind == ServiceMapNodeKind.Service);
        Assert.Contains(map.Nodes, n => n.Id == "Demo.IInvoiceRepository" && n.Kind == ServiceMapNodeKind.Service);
        Assert.Contains(map.Nodes, n => n.Kind == ServiceMapNodeKind.Database);

        Assert.Contains(map.Edges, e => e.From == "POST /invoices" && e.To == "Demo.IInvoiceService" && e.Kind == ServiceMapEdgeKind.Invokes);
        Assert.Contains(map.Edges, e => e.From == "Demo.IInvoiceService" && e.To == "Demo.IInvoiceRepository" && e.Kind == ServiceMapEdgeKind.Calls);
        Assert.Contains(map.Edges, e => e.From == "Demo.IInvoiceRepository" && e.Kind == ServiceMapEdgeKind.Database);
    }

    [Fact]
    public async Task ExtractsExternalHttpUrls_FromNotes()
    {
        var graph = MakeGraph("POST /charge", root =>
            root.Add(MakeCall(CallNodeKind.Interface, "Demo.IPayments", "Charge", calls =>
            {
                calls.Add(MakeCall(CallNodeKind.ExternalHttp, "Demo.StripeClient", "PostAsync", _ => { },
                    notes: "→ https://api.stripe.com/v1/charges"));
            })));

        var map = await BuildMap(new[] { graph });

        var external = Assert.Single(map.Nodes.Where(n => n.Kind == ServiceMapNodeKind.ExternalHttp));
        Assert.Equal("https://api.stripe.com/v1/charges", external.Label);
        Assert.Equal("http:https://api.stripe.com/v1/charges", external.Id);
    }

    [Fact]
    public async Task ComputesFanInFanOut_ForServiceUsedByTwoEndpoints()
    {
        var g1 = MakeGraph("GET /a", root => root.Add(MakeCall(CallNodeKind.Interface, "Demo.IShared", "DoIt")));
        var g2 = MakeGraph("GET /b", root => root.Add(MakeCall(CallNodeKind.Interface, "Demo.IShared", "DoIt")));

        var map = await BuildMap(new[] { g1, g2 });

        var shared = map.Nodes.Single(n => n.Id == "Demo.IShared");
        Assert.Equal(2, shared.Metrics.FanIn);
        Assert.Equal(0, shared.Metrics.FanOut);
        // Pure-stable service: instability ratio = 0 / (2 + 0) = 0.
        Assert.Equal(0.0, shared.Metrics.Instability);
    }

    [Fact]
    public async Task ComputesDepth_AlongLongestChain()
    {
        var graph = MakeGraph("GET /deep", root =>
            root.Add(MakeCall(CallNodeKind.Interface, "Demo.A", "M", a =>
            {
                a.Add(MakeCall(CallNodeKind.Interface, "Demo.B", "M", b =>
                {
                    b.Add(MakeCall(CallNodeKind.Interface, "Demo.C", "M", c =>
                    {
                        c.Add(MakeCall(CallNodeKind.Database, "Demo.Db", "Save"));
                    }));
                }));
            })));

        var map = await BuildMap(new[] { graph });

        var endpoint = map.Nodes.Single(n => n.Id == "GET /deep");
        // depth from endpoint: A→B→C→Db = 4 hops.
        Assert.True(endpoint.Metrics.Depth >= 4, $"expected ≥ 4, got {endpoint.Metrics.Depth}");
    }

    [Fact]
    public async Task DetectsCommunities_BysSharedDownstreamServices()
    {
        // users cluster: two endpoints share IUserSvc. billing cluster: two endpoints
        // share IBillingSvc. App-root edges must NOT merge them into one community.
        var u1 = MakeGraph("GET /users", root => root.Add(MakeCall(CallNodeKind.Interface, "Demo.IUserSvc", "List")));
        var u2 = MakeGraph("POST /users", root => root.Add(MakeCall(CallNodeKind.Interface, "Demo.IUserSvc", "Create")));
        var b1 = MakeGraph("GET /billing", root => root.Add(MakeCall(CallNodeKind.Interface, "Demo.IBillingSvc", "List")));
        var b2 = MakeGraph("POST /billing/pay", root => root.Add(MakeCall(CallNodeKind.Interface, "Demo.IBillingSvc", "Pay",
            calls => calls.Add(MakeCall(CallNodeKind.Database, "Demo.Db", "Save")))));

        var map = await BuildMap(new[] { u1, u2, b1, b2 });

        int CommunityOf(string id) => map.Nodes.First(n => n.Id == id).CommunityIndex;
        Assert.Equal(CommunityOf("GET /users"), CommunityOf("POST /users"));
        Assert.Equal(CommunityOf("GET /billing"), CommunityOf("POST /billing/pay"));
        Assert.NotEqual(CommunityOf("GET /users"), CommunityOf("GET /billing"));

        // Service rides with its endpoints.
        Assert.Equal(CommunityOf("GET /users"), CommunityOf("Demo.IUserSvc"));

        // App root belongs to no community.
        Assert.Equal(-1, map.Nodes.First(n => n.Id == "app:host").CommunityIndex);

        // Billing community carries the DB boundary → higher risk → sorts first.
        var communities = map.Communities;
        Assert.True(communities.Count >= 2, $"expected >= 2 communities, got {communities.Count}");
        var billing = communities.First(c => c.Label == "billing");
        var users = communities.First(c => c.Label == "users");
        Assert.True(billing.RiskScore > users.RiskScore,
            $"billing risk {billing.RiskScore} should exceed users risk {users.RiskScore}");
        Assert.True(billing.Index < users.Index, "communities must be risk-ordered");
        Assert.Equal(2, billing.EndpointCount);
    }

    [Fact]
    public async Task EdgelessEndpoints_GroupIntoPrefixCommunities()
    {
        var g1 = MakeGraph("GET /ping", _ => { });
        var g2 = MakeGraph("GET /ping/deep", _ => { });
        var g3 = MakeGraph("GET /health", _ => { });

        var map = await BuildMap(new[] { g1, g2, g3 });

        int CommunityOf(string id) => map.Nodes.First(n => n.Id == id).CommunityIndex;
        Assert.Equal(CommunityOf("GET /ping"), CommunityOf("GET /ping/deep"));
        Assert.NotEqual(CommunityOf("GET /ping"), CommunityOf("GET /health"));
        Assert.Contains(map.Communities, c => c.Label == "ping" && c.EndpointCount == 2);
    }

    [Fact]
    public async Task RiskScore_RanksBoundaryHeavyEndpointHigher()
    {
        var deep = MakeGraph("POST /charge", root =>
            root.Add(MakeCall(CallNodeKind.Interface, "Demo.IPay", "Charge", calls =>
            {
                calls.Add(MakeCall(CallNodeKind.ExternalHttp, "Demo.Stripe", "Post", _ => { }, notes: "→ https://api.stripe.com/x"));
                calls.Add(MakeCall(CallNodeKind.Database, "Demo.Db", "Save"));
            })));
        var shallow = MakeGraph("GET /status", root => root.Add(MakeCall(CallNodeKind.Interface, "Demo.IStatus", "Get")));

        var map = await BuildMap(new[] { deep, shallow });

        var chargeRisk = map.Nodes.First(n => n.Id == "POST /charge").Metrics.Risk;
        var statusRisk = map.Nodes.First(n => n.Id == "GET /status").Metrics.Risk;
        Assert.True(chargeRisk > statusRisk, $"charge {chargeRisk} should outrank status {statusRisk}");
    }

    [Fact]
    public async Task CollapsesSubgraphsIntoAppRoot_AndIslandsIsolatedEndpoints()
    {
        // Endpoints that reach a boundary get an app:host edge, so otherwise-disconnected
        // subgraphs deliberately collapse into one component; only endpoints with no
        // downstream calls are flagged isolated and left as their own island.
        var g1 = MakeGraph("GET /alpha", root => root.Add(MakeCall(CallNodeKind.Interface, "Demo.AlphaSvc", "M")));
        var g2 = MakeGraph("GET /beta", root => root.Add(MakeCall(CallNodeKind.Interface, "Demo.BetaSvc", "M")));
        var lonely = MakeGraph("GET /lonely", _ => { });

        var map = await BuildMap(new[] { g1, g2, lonely });

        var alphaIsland = map.Nodes.First(n => n.Id == "GET /alpha").IslandIndex;
        var betaIsland = map.Nodes.First(n => n.Id == "GET /beta").IslandIndex;
        Assert.Equal(alphaIsland, betaIsland);

        var lonelyNode = map.Nodes.First(n => n.Id == "GET /lonely");
        Assert.True(lonelyNode.IsIsolated);
        Assert.NotEqual(alphaIsland, lonelyNode.IslandIndex);
        Assert.True(map.Islands.Count >= 2,
            $"expected ≥ 2 islands, got {map.Islands.Count}");
    }

    [Fact]
    public async Task SiblingEndpointsCount_GroupsEndpointsSharingService()
    {
        var g1 = MakeGraph("GET /a", root => root.Add(MakeCall(CallNodeKind.Interface, "Demo.Shared", "M")));
        var g2 = MakeGraph("GET /b", root => root.Add(MakeCall(CallNodeKind.Interface, "Demo.Shared", "M")));
        var g3 = MakeGraph("GET /c", root => root.Add(MakeCall(CallNodeKind.Interface, "Demo.Shared", "M")));

        var map = await BuildMap(new[] { g1, g2, g3 });

        // Each endpoint touches Demo.Shared which is touched by 2 other endpoints.
        foreach (var ep in map.Nodes.Where(n => n.Kind == ServiceMapNodeKind.Endpoint))
        {
            Assert.Equal(2, ep.Metrics.SiblingEndpoints);
        }
    }

    [Fact]
    public async Task CouplingScore_HigherForServiceWithMoreReach()
    {
        // Demo.Hot calls 3 things; Demo.Cold calls 0. Hot must score higher.
        var graph = MakeGraph("GET /both", root =>
        {
            root.Add(MakeCall(CallNodeKind.Interface, "Demo.Hot", "M", hot =>
            {
                hot.Add(MakeCall(CallNodeKind.Interface, "Demo.A", "M"));
                hot.Add(MakeCall(CallNodeKind.Interface, "Demo.B", "M"));
                hot.Add(MakeCall(CallNodeKind.Database, "Demo.Db", "Save"));
            }));
            root.Add(MakeCall(CallNodeKind.Interface, "Demo.Cold", "M"));
        });

        var map = await BuildMap(new[] { graph });

        var hot = map.Nodes.Single(n => n.Id == "Demo.Hot");
        var cold = map.Nodes.Single(n => n.Id == "Demo.Cold");
        Assert.True(hot.Metrics.Coupling > cold.Metrics.Coupling,
            $"hot={hot.Metrics.Coupling} cold={cold.Metrics.Coupling}");
    }

    [Fact]
    public async Task IncludesEndpoints_WithNoCallGraph()
    {
        var graph = MakeGraph("GET /has-graph", root => root.Add(MakeCall(CallNodeKind.Interface, "Demo.Svc", "M")));
        var map = await BuildMap(new[] { graph },
            extraEndpoints: new[]
            {
                new EndpointDescriptor { Id = "GET /no-graph", Method = "GET", Path = "/no-graph" }
            });

        Assert.Contains(map.Nodes, n => n.Id == "GET /no-graph" && n.Kind == ServiceMapNodeKind.Endpoint);
        // Orphan endpoint should be in its own island.
        var orphan = map.Nodes.Single(n => n.Id == "GET /no-graph");
        var withGraph = map.Nodes.Single(n => n.Id == "GET /has-graph");
        Assert.NotEqual(orphan.IslandIndex, withGraph.IslandIndex);
    }

    // ---- helpers ----

    private static async Task<ServiceMap> BuildMap(IEnumerable<CallGraphNode> graphs, IEnumerable<EndpointDescriptor>? extraEndpoints = null)
    {
        var store = new InMemoryCallGraphStore();
        foreach (var g in graphs) await store.SaveAsync(g);

        var endpoints = graphs
            .Select(g => new EndpointDescriptor { Id = g.EndpointId, Method = g.EndpointId.Split(' ')[0], Path = g.EndpointId.Split(' ')[1] })
            .Concat(extraEndpoints ?? Array.Empty<EndpointDescriptor>())
            .ToList();
        var discovery = new FakeDiscovery(endpoints);

        var builder = new ServiceMapBuilder(store, discovery);
        return await builder.BuildAsync();
    }

    private static CallGraphNode MakeGraph(string endpointId, Action<List<CallNode>> configureRoot)
    {
        var children = new List<CallNode>();
        configureRoot(children);
        var root = new CallNode
        {
            DisplayName = endpointId,
            Kind = CallNodeKind.ControllerMethod,
            Calls = children
        };
        return new CallGraphNode
        {
            EndpointId = endpointId,
            RootMethod = endpointId,
            GeneratedAt = DateTimeOffset.UtcNow,
            AssemblyHash = "test",
            RootCall = root
        };
    }

    private static CallNode MakeCall(
        CallNodeKind kind,
        string declaringType,
        string methodName,
        Action<List<CallNode>>? configureChildren = null,
        string? notes = null)
    {
        var children = new List<CallNode>();
        configureChildren?.Invoke(children);
        return new CallNode
        {
            DisplayName = $"{declaringType}.{methodName}",
            DeclaringType = declaringType,
            MethodName = methodName,
            Kind = kind,
            Notes = notes,
            Calls = children
        };
    }

    private sealed class FakeDiscovery : IEndpointDiscoveryService
    {
        private readonly IReadOnlyList<EndpointDescriptor> _endpoints;
        public FakeDiscovery(IReadOnlyList<EndpointDescriptor> endpoints) { _endpoints = endpoints; }
        public IReadOnlyList<EndpointDescriptor> GetEndpoints() => _endpoints;
    }

    private sealed class InMemoryCallGraphStore : ICallGraphStore
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
