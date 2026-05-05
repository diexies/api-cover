using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using APICover.Abstractions.Models;

namespace APICover.IntegrationTests;

/// <summary>
/// End-to-end tests for streaming nodes: the sample app exposes a 5-message SSE endpoint
/// at <c>/jobs/{id}/events</c>; we drive it with both <c>collect</c> and <c>until</c> modes.
/// </summary>
public class StreamingScenarioTests : IClassFixture<SampleWebApplicationFactory>
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) }
    };

    private readonly SampleWebApplicationFactory _factory;
    public StreamingScenarioTests(SampleWebApplicationFactory factory) => _factory = factory;

    [Fact]
    public async Task Until_mode_stops_at_completed_event()
    {
        var client = _factory.CreateClient();
        const string scenarioId = "stream-until";
        var scenarioJson = $$"""
        {
            "id": "{{scenarioId}}",
            "name": "Wait until job completes",
            "nodes": [
                {
                    "id": "watch",
                    "method": "GET",
                    "path": "/jobs/{id}/events",
                    "pathParameters": { "id": "abc-123" },
                    "streaming": {
                        "mode": "until",
                        "parser": "sse",
                        "until": { "==": [{ "var": "message.data.status" }, "completed"] },
                        "timeout": "00:00:10"
                    }
                }
            ],
            "edges": []
        }
        """;
        (await client.PutAsync($"/apicover/api/scenarios/{scenarioId}",
            new StringContent(scenarioJson, System.Text.Encoding.UTF8, "application/json")))
            .EnsureSuccessStatusCode();

        var run = await StartAndWait(client, scenarioId);

        Assert.Equal(RunStatus.Succeeded, run.Status);
        var watch = run.GetResult("watch", BranchPath.Root)!;
        Assert.Equal(NodeStatus.Succeeded, watch.Status);

        var body = watch.Response!.Body!;
        Assert.Equal("completed", body["data"]!["status"]!.GetValue<string>());
        Assert.Equal(5, body["data"]!["step"]!.GetValue<int>());

        // Engine attaches stream telemetry headers.
        Assert.True(watch.Response.Headers.ContainsKey("X-Utopia-Stream-Until-Matched"));
    }

    [Fact]
    public async Task Collect_mode_returns_all_events_as_array()
    {
        var client = _factory.CreateClient();
        const string scenarioId = "stream-collect";
        var scenarioJson = $$"""
        {
            "id": "{{scenarioId}}",
            "name": "Collect job events",
            "nodes": [
                {
                    "id": "watch",
                    "method": "GET",
                    "path": "/jobs/{id}/events",
                    "pathParameters": { "id": "xyz" },
                    "streaming": { "mode": "collect", "parser": "sse" }
                }
            ],
            "edges": []
        }
        """;
        (await client.PutAsync($"/apicover/api/scenarios/{scenarioId}",
            new StringContent(scenarioJson, System.Text.Encoding.UTF8, "application/json")))
            .EnsureSuccessStatusCode();

        var run = await StartAndWait(client, scenarioId);
        Assert.Equal(RunStatus.Succeeded, run.Status);

        var body = run.GetResult("watch", BranchPath.Root)!.Response!.Body!;
        var arr = body.AsArray();
        Assert.Equal(5, arr.Count);
        Assert.Equal("running", arr[0]!["data"]!["status"]!.GetValue<string>());
        Assert.Equal("completed", arr[4]!["data"]!["status"]!.GetValue<string>());
    }

    private async Task<Run> StartAndWait(HttpClient client, string scenarioId)
    {
        var startResponse = await client.PostAsync(
            $"/apicover/api/scenarios/{scenarioId}/runs",
            JsonContent.Create(new { breakpointsEnabled = false }, options: Json));
        startResponse.EnsureSuccessStatusCode();
        var startedRun = (await startResponse.Content.ReadFromJsonAsync<Run>(Json))!;

        var deadline = DateTime.UtcNow.AddSeconds(20);
        while (DateTime.UtcNow < deadline)
        {
            var current = await client.GetFromJsonAsync<Run>($"/apicover/api/runs/{startedRun.Id}", Json);
            if (current is not null && current.Status is RunStatus.Succeeded or RunStatus.Failed or RunStatus.Cancelled)
            {
                return current;
            }
            await Task.Delay(50);
        }
        throw new TimeoutException($"Run {startedRun.Id} did not finish within 20s.");
    }
}
