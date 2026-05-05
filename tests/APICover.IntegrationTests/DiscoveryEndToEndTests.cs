using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Mvc.Testing;

namespace APICover.IntegrationTests;

/// <summary>
/// Hits the live discovery endpoints on the sample app and asserts the enriched payload
/// surfaces both minimal-API and controller endpoints with their schemas, responses,
/// and Utopia <c>Explore*</c> metadata.
/// </summary>
public class DiscoveryEndToEndTests : IClassFixture<SampleWebApplicationFactory>
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) }
    };

    private readonly SampleWebApplicationFactory _factory;

    public DiscoveryEndToEndTests(SampleWebApplicationFactory factory) => _factory = factory;

    [Fact]
    public async Task Discovery_endpoint_returns_enriched_minimal_api_payload()
    {
        var client = _factory.CreateClient();

        var response = await client.GetAsync("/apicover/api/discovery");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var endpoints = await response.Content.ReadFromJsonAsync<JsonArray>(Json);
        Assert.NotNull(endpoints);

        // POST /users is exposed via the minimal-API user group.
        var createUser = FindEndpoint(endpoints!, "POST", "/users");
        Assert.NotNull(createUser);
        Assert.Equal("user", createUser!["area"]!.GetValue<string>());
        Assert.Equal("user-action", createUser["purpose"]!.GetValue<string>());
        Assert.Equal("Create user", createUser["displayName"]!.GetValue<string>());
        Assert.Equal("minimalApi", createUser["source"]!.GetValue<string>());

        var samples = createUser["samples"] as JsonArray;
        Assert.NotNull(samples);
        Assert.Single(samples!);
        Assert.Equal("ada", samples![0]!["name"]!.GetValue<string>());
    }

    [Fact]
    public async Task Discovery_surfaces_controller_endpoints_with_class_level_area()
    {
        var client = _factory.CreateClient();

        var endpoints = await client.GetFromJsonAsync<JsonArray>("/apicover/api/discovery", Json);

        var getInvoice = FindEndpoint(endpoints!, "GET", "/billing/invoices/{id}");
        Assert.NotNull(getInvoice);
        Assert.Equal("billing", getInvoice!["area"]!.GetValue<string>());
        // Method-level ExploreEndpoint(Purpose=…) overrides the class-level "internal".
        Assert.Equal("user-action", getInvoice["purpose"]!.GetValue<string>());
        Assert.Equal("controller", getInvoice["source"]!.GetValue<string>());

        var responses = (JsonArray)getInvoice["responses"]!;
        Assert.Contains(responses, r => r!["statusCode"]!.GetValue<int>() == 200);
        Assert.Contains(responses, r => r!["statusCode"]!.GetValue<int>() == 404);
    }

    [Fact]
    public async Task ExploreIgnore_endpoints_are_absent_from_discovery()
    {
        var client = _factory.CreateClient();
        var endpoints = await client.GetFromJsonAsync<JsonArray>("/apicover/api/discovery", Json);

        // Minimal-API root and the [ExploreIgnore] DELETE /billing/invoices/{id}.
        Assert.Null(FindEndpoint(endpoints!, "GET", "/"));
        Assert.Null(FindEndpoint(endpoints!, "DELETE", "/billing/invoices/{id}"));
    }

    [Fact]
    public async Task Request_body_carries_schema_and_example()
    {
        var client = _factory.CreateClient();
        var endpoints = await client.GetFromJsonAsync<JsonArray>("/apicover/api/discovery", Json);

        var createUser = FindEndpoint(endpoints!, "POST", "/users");
        Assert.NotNull(createUser);
        var requestBody = createUser!["requestBody"]!;
        var content = (JsonArray)requestBody["content"]!;
        Assert.NotEmpty(content);
        var first = content[0]!;
        Assert.NotNull(first["schema"]);
        Assert.NotNull(first["example"]);

        var schema = first["schema"]!;
        Assert.Equal("object", schema["type"]!.GetValue<string>());
        var props = (JsonObject)schema["properties"]!;
        Assert.True(props.ContainsKey("name"));
        Assert.True(props.ContainsKey("id"));
    }

    [Fact]
    public async Task Grouped_endpoint_buckets_by_area()
    {
        var client = _factory.CreateClient();

        var grouped = await client.GetFromJsonAsync<JsonObject>("/apicover/api/discovery/grouped", Json);
        Assert.NotNull(grouped);

        var areas = (JsonArray)grouped!["areas"]!;
        var areaNames = areas.Select(a => a!["name"]!.GetValue<string>()).ToList();
        Assert.Contains("user", areaNames);
        Assert.Contains("billing", areaNames);

        // No uncategorized bucket because every endpoint either has an attribute or is ignored
        // (and the BillingController falls under controller-name convention "billing" anyway).
        var billingArea = areas.First(a => a!["name"]!.GetValue<string>() == "billing");
        var billingEndpoints = (JsonArray)billingArea!["endpoints"]!;
        Assert.Equal(2, billingEndpoints.Count);
    }

    private static JsonNode? FindEndpoint(JsonArray endpoints, string method, string path)
    {
        foreach (var ep in endpoints)
        {
            if (ep is null) continue;
            if (ep["method"]?.GetValue<string>() == method && ep["path"]?.GetValue<string>() == path)
            {
                return ep;
            }
        }
        return null;
    }
}
