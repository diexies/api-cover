using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using APICover.Abstractions.Models;
using APICover.Abstractions.Services;
using APICover.Agent.Tools;

namespace APICover.Agent.Tests;

public class CustomToolInvokerTests
{
    private static JsonElement Schema(string json) => JsonDocument.Parse(json).RootElement.Clone();

    [Fact]
    public void InterpolatesUrlEncodingValues()
    {
        var args = new JsonObject { ["id"] = "a b/c" };
        var url = CustomToolInvoker.InterpolateUrl("/api/users/{{id}}", args);
        Assert.Equal("/api/users/a%20b%2Fc", url);
    }

    [Fact]
    public void InterpolatesJsonBodyAsJsonValues()
    {
        var args = new JsonObject
        {
            ["name"] = "Acme",
            ["meta"] = new JsonObject { ["x"] = 1 },
        };
        var body = CustomToolInvoker.InterpolateJsonBody(
            "{\"name\":{{name}},\"meta\":{{meta}}}",
            args);
        // String becomes quoted JSON; nested object stays as JSON not as escaped string.
        var parsed = JsonNode.Parse(body)!.AsObject();
        Assert.Equal("Acme", (string)parsed["name"]!);
        Assert.Equal(1, (int)parsed["meta"]!["x"]!);
    }

    [Fact]
    public void InterpolatesJsonBodyPreventsInjection()
    {
        var args = new JsonObject { ["evil"] = "\",\"injected\":true,\"x\":\"" };
        var body = CustomToolInvoker.InterpolateJsonBody("{\"safe\":{{evil}}}", args);
        var parsed = JsonNode.Parse(body)!.AsObject();
        // The whole hostile string lives inside the "safe" value — no extra keys appear.
        Assert.Single(parsed);
        Assert.Equal("\",\"injected\":true,\"x\":\"", (string)parsed["safe"]!);
    }

    [Fact]
    public async Task ReturnsNullWhenToolUnknown()
    {
        var store = new InMemoryStore();
        var invoker = new CustomToolInvoker(new NoopFactory(), store);
        var result = await invoker.TryInvokeAsync("does.not.exist", new JsonObject());
        Assert.Null(result);
    }

    [Fact]
    public async Task ReportsMissingRequiredParam()
    {
        var store = new InMemoryStore();
        await store.SaveAsync(new CustomToolDefinition
        {
            Name = "users.fetch",
            Description = "x",
            WhenTriggered = "x",
            Method = "GET",
            UrlTemplate = "/api/users/{{id}}",
            ParamsSchema = Schema("""{"properties":{"id":{"type":"string"}},"required":["id"]}"""),
        });
        var invoker = new CustomToolInvoker(new NoopFactory(), store);
        var result = await invoker.TryInvokeAsync("users.fetch", new JsonObject());
        Assert.NotNull(result);
        Assert.False((bool)result!["ok"]!);
        Assert.Contains("id", (string)result["error"]!);
    }

    [Fact]
    public async Task ExecutesAgainstStubHandler()
    {
        var store = new InMemoryStore();
        await store.SaveAsync(new CustomToolDefinition
        {
            Name = "ping.echo",
            Description = "x",
            WhenTriggered = "x",
            Method = "POST",
            UrlTemplate = "/echo/{{id}}",
            BodyTemplate = "{\"value\":{{value}}}",
            ParamsSchema = Schema("""{"properties":{"id":{"type":"string"},"value":{"type":"string"}},"required":["id","value"]}"""),
        });

        var handler = new StubHandler((req, body) =>
        {
            Assert.Equal(HttpMethod.Post, req.Method);
            Assert.EndsWith("/echo/42", req.RequestUri!.ToString());
            var parsed = JsonNode.Parse(body)!.AsObject();
            Assert.Equal("hello", (string)parsed["value"]!);
            return new HttpResponseMessage(HttpStatusCode.Created)
            {
                Content = new StringContent("{\"created\":true}", Encoding.UTF8, "application/json"),
            };
        });
        var factory = new SingleClientFactory(handler, new Uri("http://test.local"));
        var invoker = new CustomToolInvoker(factory, store);
        var result = await invoker.TryInvokeAsync("ping.echo", new JsonObject { ["id"] = "42", ["value"] = "hello" });
        Assert.NotNull(result);
        Assert.True((bool)result!["ok"]!);
        Assert.Equal(201, (int)result["status"]!);
        Assert.True((bool)result["body"]!["created"]!);
    }

    private sealed class InMemoryStore : ICustomToolStore
    {
        private readonly Dictionary<string, CustomToolDefinition> _map = new();
        public string Root => "memory";
        public Task<IReadOnlyList<CustomToolDefinition>> ListAsync(CancellationToken ct = default)
            => Task.FromResult((IReadOnlyList<CustomToolDefinition>)_map.Values.ToArray());
        public Task<CustomToolDefinition?> GetAsync(string name, CancellationToken ct = default)
            => Task.FromResult(_map.GetValueOrDefault(name));
        public Task SaveAsync(CustomToolDefinition def, CancellationToken ct = default)
        {
            _map[def.Name] = def;
            return Task.CompletedTask;
        }
        public Task DeleteAsync(string name, CancellationToken ct = default)
        {
            _map.Remove(name);
            return Task.CompletedTask;
        }
    }

    private sealed class NoopFactory : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(new StubHandler((_, _) => new HttpResponseMessage(HttpStatusCode.OK)));
    }

    private sealed class SingleClientFactory : IHttpClientFactory
    {
        private readonly HttpMessageHandler _handler;
        private readonly Uri _baseAddress;
        public SingleClientFactory(HttpMessageHandler h, Uri baseAddress)
        {
            _handler = h;
            _baseAddress = baseAddress;
        }
        public HttpClient CreateClient(string name) => new(_handler, disposeHandler: false) { BaseAddress = _baseAddress };
    }

    private sealed class StubHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, string, HttpResponseMessage> _fn;
        public StubHandler(Func<HttpRequestMessage, string, HttpResponseMessage> fn) { _fn = fn; }
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var body = request.Content is null ? string.Empty : await request.Content.ReadAsStringAsync(cancellationToken);
            return _fn(request, body);
        }
    }
}
