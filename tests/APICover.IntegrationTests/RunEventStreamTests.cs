using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace APICover.IntegrationTests;

/// <summary>
/// Spins up a scenario, subscribes to <c>GET /apicover/api/runs/{id}/events</c>, and
/// asserts the engine publishes the expected lifecycle telemetry (started → node started →
/// node completed → finished). Works against the in-memory <c>InMemoryRunEventBus</c>.
/// </summary>
public class RunEventStreamTests : IClassFixture<SampleWebApplicationFactory>
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) }
    };

    private readonly SampleWebApplicationFactory _factory;
    public RunEventStreamTests(SampleWebApplicationFactory factory) => _factory = factory;

    [Fact]
    public async Task Subscriber_receives_node_lifecycle_events_and_finish()
    {
        var client = _factory.CreateClient();

        // Two-node scenario with a breakpoint on the first node so we have time to subscribe.
        const string scenarioId = "events-test";
        var scenarioJson = $$"""
        {
            "id": "{{scenarioId}}",
            "name": "Events test",
            "nodes": [
                { "id": "create", "method": "POST", "path": "/users", "body": { "name": "Lin" } },
                {
                    "id": "fetch", "method": "GET", "path": "/users/{id}",
                    "pathParameters": { "id": { "var": "nodes.create.response.body.id" } }
                }
            ],
            "edges": [{ "from": "create", "to": "fetch", "mode": "sequential" }],
            "breakpoints": [{ "nodeId": "create", "enabled": true }]
        }
        """;
        (await client.PutAsync($"/apicover/api/scenarios/{scenarioId}",
            new StringContent(scenarioJson, System.Text.Encoding.UTF8, "application/json")))
            .EnsureSuccessStatusCode();

        var startResponse = await client.PostAsync(
            $"/apicover/api/scenarios/{scenarioId}/runs",
            JsonContent.Create(new { breakpointsEnabled = true }, options: Json));
        startResponse.EnsureSuccessStatusCode();
        var startedRun = await startResponse.Content.ReadFromJsonAsync<JsonElement>(Json);
        var runId = startedRun.GetProperty("id").GetString()!;

        // Wait until run hits the breakpoint (Paused), then subscribe and only then resolve.
        await WaitUntilStatus(client, runId, "paused");

        using var streamClient = _factory.CreateClient();
        streamClient.Timeout = TimeSpan.FromSeconds(20);
        using var streamResponse = await streamClient.GetAsync(
            $"/apicover/api/runs/{runId}/events",
            HttpCompletionOption.ResponseHeadersRead);
        streamResponse.EnsureSuccessStatusCode();
        Assert.Equal("text/event-stream", streamResponse.Content.Headers.ContentType?.MediaType);

        // Resume the breakpoint so the rest of the run produces events.
        var resolveBody = JsonContent.Create(new { action = "resume" }, options: Json);
        (await client.PostAsync($"/apicover/api/runs/{runId}/breakpoints/create/resolve", resolveBody))
            .EnsureSuccessStatusCode();

        await using var body = await streamResponse.Content.ReadAsStreamAsync();
        using var reader = new StreamReader(body);

        var eventNames = new List<string>();
        var deadline = DateTime.UtcNow.AddSeconds(15);
        string? line;
        string? currentEvent = null;
        while (DateTime.UtcNow < deadline && (line = await reader.ReadLineAsync()) is not null)
        {
            if (line.StartsWith("event: ", StringComparison.Ordinal))
            {
                currentEvent = line["event: ".Length..];
            }
            else if (line.Length == 0 && currentEvent is not null)
            {
                eventNames.Add(currentEvent);
                if (currentEvent == "runFinished") break;
                currentEvent = null;
            }
        }

        Assert.Contains("nodeResumed", eventNames);
        Assert.Contains("nodeCompleted", eventNames);
        Assert.Contains("runFinished", eventNames);
    }

    private static async Task WaitUntilStatus(HttpClient client, string runId, string targetStatus)
    {
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (DateTime.UtcNow < deadline)
        {
            var current = await client.GetFromJsonAsync<JsonElement>($"/apicover/api/runs/{runId}", Json);
            if (current.GetProperty("status").GetString() == targetStatus) return;
            await Task.Delay(20);
        }
        throw new TimeoutException($"Run {runId} never reached status '{targetStatus}'.");
    }

    [Fact]
    public async Task Subscribing_after_run_finished_replays_snapshot_and_closes()
    {
        var client = _factory.CreateClient();

        const string scenarioId = "events-late-test";
        var scenarioJson = $$"""
        {
            "id": "{{scenarioId}}",
            "name": "Late subscribe",
            "nodes": [
                { "id": "list", "method": "GET", "path": "/users" }
            ],
            "edges": []
        }
        """;
        (await client.PutAsync($"/apicover/api/scenarios/{scenarioId}",
            new StringContent(scenarioJson, System.Text.Encoding.UTF8, "application/json")))
            .EnsureSuccessStatusCode();

        var startResponse = await client.PostAsync(
            $"/apicover/api/scenarios/{scenarioId}/runs",
            JsonContent.Create(new { breakpointsEnabled = false }, options: Json));
        var startedRun = await startResponse.Content.ReadFromJsonAsync<JsonElement>(Json);
        var runId = startedRun.GetProperty("id").GetString()!;

        // Wait for completion via polling.
        var deadline = DateTime.UtcNow.AddSeconds(15);
        while (DateTime.UtcNow < deadline)
        {
            var current = await client.GetFromJsonAsync<JsonElement>($"/apicover/api/runs/{runId}", Json);
            var status = current.GetProperty("status").GetString();
            if (status is "succeeded" or "failed" or "cancelled") break;
            await Task.Delay(50);
        }

        // Now subscribe; should immediately see snapshot + runFinished, then close.
        using var streamResponse = await client.GetAsync(
            $"/apicover/api/runs/{runId}/events",
            HttpCompletionOption.ResponseHeadersRead);
        streamResponse.EnsureSuccessStatusCode();

        await using var body = await streamResponse.Content.ReadAsStreamAsync();
        using var reader = new StreamReader(body);

        var eventNames = new List<string>();
        string? line;
        string? currentEvent = null;
        while ((line = await reader.ReadLineAsync()) is not null)
        {
            if (line.StartsWith("event: ", StringComparison.Ordinal))
            {
                currentEvent = line["event: ".Length..];
            }
            else if (line.Length == 0 && currentEvent is not null)
            {
                eventNames.Add(currentEvent);
                currentEvent = null;
            }
        }

        Assert.Contains("snapshot", eventNames);
        Assert.Contains("runFinished", eventNames);
    }
}
