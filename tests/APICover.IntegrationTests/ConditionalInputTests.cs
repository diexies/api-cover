using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using APICover.Abstractions.Models;

namespace APICover.IntegrationTests;

/// <summary>
/// Verifies that the engine evaluates a JSONLogic <c>{ "if": [...] }</c> chain embedded in a
/// request body — the wire format produced by <c>ConditionalValueChip</c> in the UI. The
/// scenario sends <c>POST /users</c> with a body field that branches on the run input's
/// quantity; we assert the request snapshot's body reflects the correct branch.
/// </summary>
public class ConditionalInputTests : IClassFixture<SampleWebApplicationFactory>
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) }
    };

    private readonly SampleWebApplicationFactory _factory;

    public ConditionalInputTests(SampleWebApplicationFactory factory) => _factory = factory;

    [Theory]
    [InlineData(15, "bulk")]
    [InlineData(5, "single")]
    public async Task Conditional_body_field_resolves_via_run_input(int qty, string expectedName)
    {
        var client = _factory.CreateClient();

        var scenarioId = $"conditional-input-{qty}";
        var scenarioJson = $$"""
        {
            "id": "{{scenarioId}}",
            "name": "Conditional input demo",
            "nodes": [
                {
                    "id": "create",
                    "method": "POST",
                    "path": "/users",
                    "body": {
                        "name": {
                            "if": [
                                { ">": [ { "var": "input.qty" }, 10 ] }, "bulk",
                                "single"
                            ]
                        }
                    }
                }
            ],
            "edges": []
        }
        """;
        var put = await client.PutAsync(
            $"/apicover/api/scenarios/{scenarioId}",
            new StringContent(scenarioJson, Encoding.UTF8, "application/json"));
        put.EnsureSuccessStatusCode();

        var startBody = JsonContent.Create(new { breakpointsEnabled = false, input = new { qty } }, options: Json);
        var startResponse = await client.PostAsync($"/apicover/api/scenarios/{scenarioId}/runs", startBody);
        startResponse.EnsureSuccessStatusCode();
        var startedRun = await startResponse.Content.ReadFromJsonAsync<Run>(Json);
        Assert.NotNull(startedRun);

        var run = await PollUntilFinished(client, startedRun!.Id);
        Assert.True(run.Status == RunStatus.Succeeded,
            $"Run status was {run.Status}. Error={run.Error}");

        var create = run.GetResult("create", BranchPath.Root)!;
        Assert.Equal(NodeStatus.Succeeded, create.Status);
        Assert.Equal(201, create.Response!.Status);

        // The {if:[...]} chain in the request body should resolve to the matching branch
        // before the request leaves the engine.
        var sentName = create.Request!.Body!["name"]!.GetValue<string>();
        Assert.Equal(expectedName, sentName);

        // The sample API echoes the request body, so the response should also carry it.
        var echoedName = create.Response.Body!["name"]!.GetValue<string>();
        Assert.Equal(expectedName, echoedName);
    }

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
