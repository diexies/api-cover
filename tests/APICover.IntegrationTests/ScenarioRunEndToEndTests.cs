using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using APICover;
using APICover.Abstractions.Models;
using APICover.Engine;

namespace APICover.IntegrationTests;

/// <summary>
/// End-to-end smoke test: spins up the sample API via <see cref="WebApplicationFactory{TEntryPoint}"/>,
/// starts a scenario through the inspector HTTP API, polls until completion, and verifies that
/// the chained <c>POST /users → GET /users/{id}</c> flow propagated the JSONLogic-resolved id.
/// </summary>
public class ScenarioRunEndToEndTests : IClassFixture<SampleWebApplicationFactory>
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) }
    };

    private readonly SampleWebApplicationFactory _factory;

    public ScenarioRunEndToEndTests(SampleWebApplicationFactory factory) => _factory = factory;

    [Fact]
    public async Task CreateAndFetchUser_scenario_runs_end_to_end()
    {
        var client = _factory.CreateClient();

        // Sanity check the sample API itself.
        (await client.GetAsync("/")).EnsureSuccessStatusCode();

        // Discovery contains the sample endpoints.
        var discoveryResponse = await client.GetAsync("/apicover/api/discovery");
        Assert.Equal(HttpStatusCode.OK, discoveryResponse.StatusCode);

        // Upload the scenario JSON the way the UI would.
        const string scenarioId = "create-and-fetch-user";
        var scenarioJson = BuildCreateAndFetchUserScenarioJson(scenarioId);
        var putResponse = await client.PutAsync(
            $"/apicover/api/scenarios/{scenarioId}",
            new StringContent(scenarioJson, System.Text.Encoding.UTF8, "application/json"));
        putResponse.EnsureSuccessStatusCode();

        var scenarios = await client.GetFromJsonAsync<JsonArray>("/apicover/api/scenarios", Json);
        Assert.NotNull(scenarios);
        Assert.Contains(scenarios!, s => s!["id"]!.GetValue<string>() == scenarioId);

        // Start a run.
        var startResponse = await client.PostAsync(
            $"/apicover/api/scenarios/{scenarioId}/runs",
            JsonContent.Create(new { breakpointsEnabled = false }, options: Json));
        startResponse.EnsureSuccessStatusCode();
        var startedRun = await startResponse.Content.ReadFromJsonAsync<Run>(Json);
        Assert.NotNull(startedRun);

        // Poll until completion (engine runs in a background task).
        var run = await PollUntilFinished(client, startedRun!.Id);

        Assert.True(run.Status == RunStatus.Succeeded,
            $"Run status was {run.Status}. Error={run.Error}; Nodes={JsonSerializer.Serialize(run.NodeResults, Json)}");
        var fetch = run.GetResult("fetch", BranchPath.Root)!;
        Assert.Equal(NodeStatus.Succeeded, fetch.Status);
        Assert.Equal(200, fetch.Response!.Status);

        // The {id} placeholder must have been resolved from the create node's response body.
        var create = run.GetResult("create", BranchPath.Root)!;
        var createdId = create.Response!.Body!["id"]!.GetValue<int>();
        Assert.Equal($"/users/{createdId}", fetch.Request!.Path);
        Assert.Equal(createdId, fetch.Response.Body!["id"]!.GetValue<int>());
    }

    private static string BuildCreateAndFetchUserScenarioJson(string id) => $$"""
    {
        "id": "{{id}}",
        "name": "Create then fetch a user",
        "nodes": [
            {
                "id": "create",
                "method": "POST",
                "path": "/users",
                "body": { "name": "Ada" }
            },
            {
                "id": "fetch",
                "method": "GET",
                "path": "/users/{id}",
                "pathParameters": {
                    "id": { "var": "nodes.create.response.body.id" }
                }
            }
        ],
        "edges": [
            { "from": "create", "to": "fetch", "mode": "sequential" }
        ]
    }
    """;

    private static async Task<Run> PollUntilFinished(HttpClient client, string runId)
    {
        var deadline = DateTime.UtcNow.AddSeconds(15);
        while (DateTime.UtcNow < deadline)
        {
            var run = await client.GetFromJsonAsync<Run>($"/apicover/api/runs/{runId}", Json);
            if (run is not null && run.Status is RunStatus.Succeeded or RunStatus.Failed or RunStatus.Cancelled)
            {
                return run;
            }
            await Task.Delay(100);
        }
        throw new TimeoutException($"Run {runId} did not finish within 15s.");
    }
}

public class SampleWebApplicationFactory : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.ConfigureTestServices(services =>
        {
            // Route the engine's HttpClient back into the in-memory test server.
            services.AddHttpClient(ScenarioEngine.HttpClientNamePublic)
                .ConfigurePrimaryHttpMessageHandler(() => Server.CreateHandler())
                .ConfigureHttpClient(c => c.BaseAddress = Server.BaseAddress);
        });
    }
}
