using System.Text.Json.Nodes;
using APICover.Abstractions.Discovery;
using APICover.Abstractions.Models;
using APICover.Abstractions.Services;
using APICover.Agent.Memory;
using APICover.Agent.Tools;

namespace APICover.Agent.Tests;

public class ToolDispatcherTests
{
    [Fact]
    public async Task ListEndpoints_ReturnsAll_WhenNoFilter()
    {
        var dispatcher = new ToolDispatcher(new FakeDiscovery(SampleEndpoints()), new InMemoryAgentMemoryStore(), new APICover.Storage.InMemoryScenarioStore());

        var result = await dispatcher.DispatchAsync(ToolRegistry.ListEndpoints, null, default);

        Assert.False(result.IsError);
        Assert.Equal(3, result.Output["count"]!.GetValue<int>());
    }

    [Fact]
    public async Task ListEndpoints_FiltersByMethod()
    {
        var dispatcher = new ToolDispatcher(new FakeDiscovery(SampleEndpoints()), new InMemoryAgentMemoryStore(), new APICover.Storage.InMemoryScenarioStore());
        var input = new JsonObject { ["methodFilter"] = "POST" };

        var result = await dispatcher.DispatchAsync(ToolRegistry.ListEndpoints, input, default);

        Assert.False(result.IsError);
        Assert.Equal(1, result.Output["count"]!.GetValue<int>());
        var first = result.Output["endpoints"]!.AsArray()[0]!;
        Assert.Equal("POST", first["method"]!.GetValue<string>());
    }

    [Fact]
    public async Task GetEndpointDetails_ReturnsFullDescriptor()
    {
        var dispatcher = new ToolDispatcher(new FakeDiscovery(SampleEndpoints()), new InMemoryAgentMemoryStore(), new APICover.Storage.InMemoryScenarioStore());
        var input = new JsonObject { ["id"] = "POST /users" };

        var result = await dispatcher.DispatchAsync(ToolRegistry.GetEndpointDetails, input, default);

        Assert.False(result.IsError);
        Assert.Equal("POST /users", result.Output["id"]!.GetValue<string>());
        Assert.Equal("POST", result.Output["method"]!.GetValue<string>());
    }

    [Fact]
    public async Task GetEndpointDetails_ReturnsErrorJson_ForUnknownId()
    {
        var dispatcher = new ToolDispatcher(new FakeDiscovery(SampleEndpoints()), new InMemoryAgentMemoryStore(), new APICover.Storage.InMemoryScenarioStore());
        var input = new JsonObject { ["id"] = "GET /nonexistent" };

        var result = await dispatcher.DispatchAsync(ToolRegistry.GetEndpointDetails, input, default);

        Assert.False(result.IsError);
        Assert.NotNull(result.Output["error"]);
    }

    [Fact]
    public async Task UnknownTool_ReturnsErrorResult()
    {
        var dispatcher = new ToolDispatcher(new FakeDiscovery(SampleEndpoints()), new InMemoryAgentMemoryStore(), new APICover.Storage.InMemoryScenarioStore());

        var result = await dispatcher.DispatchAsync("invent_scenarios_for_me", null, default);

        Assert.True(result.IsError);
    }

    [Fact]
    public async Task GetEndpointDetails_ThrowsCapturedAsError_WhenIdMissing()
    {
        var dispatcher = new ToolDispatcher(new FakeDiscovery(SampleEndpoints()), new InMemoryAgentMemoryStore(), new APICover.Storage.InMemoryScenarioStore());

        var result = await dispatcher.DispatchAsync(ToolRegistry.GetEndpointDetails, new JsonObject(), default);

        Assert.True(result.IsError);
    }

    [Fact]
    public async Task RunScenario_ReturnsCondensedVerdict_WithFailedBranches()
    {
        var scenarios = new APICover.Storage.InMemoryScenarioStore();
        await scenarios.SaveAsync(new Scenario { Id = "checkout", Name = "Checkout" });
        var runs = new APICover.Storage.InMemoryRunStore();
        var engine = new FakeEngine(runs, finalStatus: RunStatus.Failed, results: new[]
        {
            MakeResult("create", new[] { "a1" }, NodeStatus.Succeeded, 201),
            MakeResult("create", new[] { "a2" }, NodeStatus.Failed, 500, "Internal Server Error"),
        });
        var dispatcher = new ToolDispatcher(
            new FakeDiscovery(SampleEndpoints()), new InMemoryAgentMemoryStore(), scenarios,
            engine: engine, runs: runs);

        var result = await dispatcher.DispatchAsync(
            ToolRegistry.RunScenario, new JsonObject { ["id"] = "checkout" }, default);

        Assert.False(result.IsError);
        Assert.Equal("Failed", result.Output["status"]!.GetValue<string>());
        Assert.Equal(1, result.Output["failedCount"]!.GetValue<int>());
        var failure = result.Output["failed"]!.AsArray()[0]!;
        Assert.Equal("create", failure["nodeId"]!.GetValue<string>());
        Assert.Equal("a2", failure["branchPath"]!.AsArray()[0]!.GetValue<string>());
        Assert.Equal(500, failure["httpStatus"]!.GetValue<int>());
    }

    [Fact]
    public async Task RunScenario_UnknownId_ReturnsGuidance()
    {
        var runs = new APICover.Storage.InMemoryRunStore();
        var dispatcher = new ToolDispatcher(
            new FakeDiscovery(SampleEndpoints()), new InMemoryAgentMemoryStore(),
            new APICover.Storage.InMemoryScenarioStore(),
            engine: new FakeEngine(runs, RunStatus.Succeeded, Array.Empty<NodeResult>()),
            runs: runs);

        var result = await dispatcher.DispatchAsync(
            ToolRegistry.RunScenario, new JsonObject { ["id"] = "ghost" }, default);

        Assert.False(result.IsError);
        Assert.Contains("save_scenario", result.Output.ToJsonString());
    }

    [Fact]
    public async Task ListScenarios_ReturnsCondensedNodeChains()
    {
        var scenarios = new APICover.Storage.InMemoryScenarioStore();
        await scenarios.SaveAsync(new Scenario
        {
            Id = "withdraw-then-approve",
            Name = "Bank withdrawal then credit approval",
            Description = "User withdraws, then credit approval fires",
            Tags = new List<string> { "banking" },
            Nodes = new List<ApiNode>
            {
                new() { Id = "w", Method = "POST", Path = "/withdrawals" },
                new() { Id = "a", Method = "POST", Path = "/credit/approve" },
            },
        });
        var dispatcher = new ToolDispatcher(new FakeDiscovery(SampleEndpoints()), new InMemoryAgentMemoryStore(), scenarios);

        var result = await dispatcher.DispatchAsync(ToolRegistry.ListScenarios, null, default);

        Assert.False(result.IsError);
        Assert.Equal(1, result.Output["count"]!.GetValue<int>());
        var s = result.Output["scenarios"]!.AsArray()[0]!;
        Assert.Equal("withdraw-then-approve", s["id"]!.GetValue<string>());
        var chain = s["nodeChain"]!.AsArray().Select(n => n!.GetValue<string>()).ToArray();
        Assert.Equal(new[] { "POST /withdrawals", "POST /credit/approve" }, chain);
    }

    [Fact]
    public async Task Plan_AddUpdateList_PersistsAcrossDispatcherInstances()
    {
        var memory = new InMemoryAgentMemoryStore();
        var d1 = new ToolDispatcher(new FakeDiscovery(SampleEndpoints()), memory, new APICover.Storage.InMemoryScenarioStore());

        var added = await d1.DispatchAsync(ToolRegistry.PlanAdd, new JsonObject { ["title"] = "Scan communities" }, default);
        Assert.False(added.IsError, added.Output.ToJsonString());
        Assert.Equal(1, added.Output["id"]!.GetValue<int>());
        Assert.Equal("pending", added.Output["status"]!.GetValue<string>());

        await d1.DispatchAsync(ToolRegistry.PlanAdd, new JsonObject { ["title"] = "Author scenarios" }, default);
        var updated = await d1.DispatchAsync(ToolRegistry.PlanUpdate, new JsonObject { ["id"] = 1, ["status"] = "done" }, default);
        Assert.Equal("done", updated.Output["status"]!.GetValue<string>());

        // Fresh dispatcher, same memory store — plan must survive (cross-run persistence).
        var d2 = new ToolDispatcher(new FakeDiscovery(SampleEndpoints()), memory, new APICover.Storage.InMemoryScenarioStore());
        var listed = await d2.DispatchAsync(ToolRegistry.PlanList, null, default);
        Assert.Equal(2, listed.Output["count"]!.GetValue<int>());
        Assert.Equal(1, listed.Output["open"]!.GetValue<int>());
    }

    [Fact]
    public async Task Dataset_SaveAndPagedRead()
    {
        var dispatcher = new ToolDispatcher(new FakeDiscovery(SampleEndpoints()), new InMemoryAgentMemoryStore(), new APICover.Storage.InMemoryScenarioStore());
        var records = new JsonArray();
        for (var i = 0; i < 30; i++) records.Add(new JsonObject { ["name"] = $"user-{i}", ["amount"] = i * 10 });

        var saved = await dispatcher.DispatchAsync(ToolRegistry.DatasetSave,
            new JsonObject { ["name"] = "Test Customers!", ["records"] = records }, default);
        Assert.Equal("test-customers", saved.Output["name"]!.GetValue<string>());
        Assert.Equal(30, saved.Output["recordCount"]!.GetValue<int>());

        var name = saved.Output["name"]!.GetValue<string>();
        var page = await dispatcher.DispatchAsync(ToolRegistry.DatasetRead,
            new JsonObject { ["name"] = name, ["offset"] = 25, ["limit"] = 10 }, default);
        Assert.Equal(30, page.Output["total"]!.GetValue<int>());
        Assert.Equal(5, page.Output["records"]!.AsArray().Count);
        Assert.Equal("user-25", page.Output["records"]!.AsArray()[0]!["name"]!.GetValue<string>());
    }

    [Fact]
    public async Task Playground_ResetDeletesOnlyPrefixedScenarios()
    {
        var memory = new InMemoryAgentMemoryStore();
        var scenarios = new APICover.Storage.InMemoryScenarioStore();
        var dispatcher = new ToolDispatcher(new FakeDiscovery(SampleEndpoints()), memory, scenarios);

        var started = await dispatcher.DispatchAsync(ToolRegistry.PlaygroundStart, new JsonObject { ["name"] = "load-trial" }, default);
        var prefix = started.Output["scenarioPrefix"]!.GetValue<string>();
        Assert.Equal("pg-load-trial-", prefix);

        await scenarios.SaveAsync(new Scenario { Id = $"{prefix}exp1", Name = "trial 1" });
        await scenarios.SaveAsync(new Scenario { Id = $"{prefix}exp2", Name = "trial 2" });
        await scenarios.SaveAsync(new Scenario { Id = "real-flow", Name = "keep me" });

        var reset = await dispatcher.DispatchAsync(ToolRegistry.PlaygroundReset, null, default);
        Assert.Equal(2, reset.Output["deletedScenarioCount"]!.GetValue<int>());
        var remaining = await scenarios.ListAsync();
        Assert.Single(remaining);
        Assert.Equal("real-flow", remaining[0].Id);

        // Reset closed the workspace — a new playground can start.
        var second = await dispatcher.DispatchAsync(ToolRegistry.PlaygroundStart, new JsonObject { ["name"] = "next" }, default);
        Assert.Equal("pg-next-", second.Output["scenarioPrefix"]!.GetValue<string>());
    }

    private static NodeResult MakeResult(string nodeId, string[] branch, NodeStatus status, int httpStatus, string? error = null) => new()
    {
        NodeId = nodeId,
        BranchPath = branch.ToList(),
        Status = status,
        Response = new ResponseSnapshot { Status = httpStatus },
        Error = error,
    };

    private static IReadOnlyList<EndpointDescriptor> SampleEndpoints() => new[]
    {
        new EndpointDescriptor { Id = "GET /users", Method = "GET", Path = "/users", Area = "user" },
        new EndpointDescriptor { Id = "POST /users", Method = "POST", Path = "/users", Area = "user" },
        new EndpointDescriptor { Id = "GET /invoices", Method = "GET", Path = "/invoices", Area = "billing" },
    };

    private sealed class FakeDiscovery : IEndpointDiscoveryService
    {
        private readonly IReadOnlyList<EndpointDescriptor> _endpoints;
        public FakeDiscovery(IReadOnlyList<EndpointDescriptor> endpoints) { _endpoints = endpoints; }
        public IReadOnlyList<EndpointDescriptor> GetEndpoints() => _endpoints;
    }

    private sealed class FakeEngine : IScenarioEngine
    {
        private readonly APICover.Storage.InMemoryRunStore _runs;
        private readonly RunStatus _finalStatus;
        private readonly IReadOnlyList<NodeResult> _results;
        public FakeEngine(APICover.Storage.InMemoryRunStore runs, RunStatus finalStatus, IReadOnlyList<NodeResult> results)
        {
            _runs = runs;
            _finalStatus = finalStatus;
            _results = results;
        }
        public async Task<Run> StartAsync(Scenario scenario, RunOptions? options = null, CancellationToken cancellationToken = default)
        {
            var run = new Run { Id = "run-1", ScenarioId = scenario.Id, Status = _finalStatus };
            foreach (var r in _results) run.NodeResults.Add(r);
            await _runs.SaveAsync(run, cancellationToken);
            return run;
        }
    }
}
