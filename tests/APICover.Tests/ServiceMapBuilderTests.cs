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
    public async Task IdentifiesIslands_TwoDisconnectedSubgraphs()
    {
        var g1 = MakeGraph("GET /alpha", root => root.Add(MakeCall(CallNodeKind.Interface, "Demo.AlphaSvc", "M")));
        var g2 = MakeGraph("GET /beta", root => root.Add(MakeCall(CallNodeKind.Interface, "Demo.BetaSvc", "M")));

        var map = await BuildMap(new[] { g1, g2 });

        Assert.True(map.Islands.Count >= 2,
            $"expected ≥ 2 islands, got {map.Islands.Count}");
        var alphaIsland = map.Nodes.First(n => n.Id == "GET /alpha").IslandIndex;
        var betaIsland = map.Nodes.First(n => n.Id == "GET /beta").IslandIndex;
        Assert.NotEqual(alphaIsland, betaIsland);
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
