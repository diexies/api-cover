using System.Text.Json.Nodes;
using APICover.Abstractions.Discovery;
using APICover.Agent.Memory;
using APICover.Agent.Tools;

namespace APICover.Agent.Tests;

public class ToolDispatcherTests
{
    [Fact]
    public async Task ListEndpoints_ReturnsAll_WhenNoFilter()
    {
        var dispatcher = new ToolDispatcher(new FakeDiscovery(SampleEndpoints()), new InMemoryAgentMemoryStore());

        var result = await dispatcher.DispatchAsync(ToolRegistry.ListEndpoints, null, default);

        Assert.False(result.IsError);
        Assert.Equal(3, result.Output["count"]!.GetValue<int>());
    }

    [Fact]
    public async Task ListEndpoints_FiltersByMethod()
    {
        var dispatcher = new ToolDispatcher(new FakeDiscovery(SampleEndpoints()), new InMemoryAgentMemoryStore());
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
        var dispatcher = new ToolDispatcher(new FakeDiscovery(SampleEndpoints()), new InMemoryAgentMemoryStore());
        var input = new JsonObject { ["id"] = "POST /users" };

        var result = await dispatcher.DispatchAsync(ToolRegistry.GetEndpointDetails, input, default);

        Assert.False(result.IsError);
        Assert.Equal("POST /users", result.Output["id"]!.GetValue<string>());
        Assert.Equal("POST", result.Output["method"]!.GetValue<string>());
    }

    [Fact]
    public async Task GetEndpointDetails_ReturnsErrorJson_ForUnknownId()
    {
        var dispatcher = new ToolDispatcher(new FakeDiscovery(SampleEndpoints()), new InMemoryAgentMemoryStore());
        var input = new JsonObject { ["id"] = "GET /nonexistent" };

        var result = await dispatcher.DispatchAsync(ToolRegistry.GetEndpointDetails, input, default);

        Assert.False(result.IsError);
        Assert.NotNull(result.Output["error"]);
    }

    [Fact]
    public async Task UnknownTool_ReturnsErrorResult()
    {
        var dispatcher = new ToolDispatcher(new FakeDiscovery(SampleEndpoints()), new InMemoryAgentMemoryStore());

        var result = await dispatcher.DispatchAsync("invent_scenarios_for_me", null, default);

        Assert.True(result.IsError);
    }

    [Fact]
    public async Task GetEndpointDetails_ThrowsCapturedAsError_WhenIdMissing()
    {
        var dispatcher = new ToolDispatcher(new FakeDiscovery(SampleEndpoints()), new InMemoryAgentMemoryStore());

        var result = await dispatcher.DispatchAsync(ToolRegistry.GetEndpointDetails, new JsonObject(), default);

        Assert.True(result.IsError);
    }

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
}
