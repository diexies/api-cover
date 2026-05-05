using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using APICover.Abstractions.Models;

namespace APICover.IntegrationTests;

/// <summary>
/// End-to-end tests for repeatable groups: drives a single node N times with per-iteration
/// JSONLogic mutations and asserts each iteration is recorded as a separately-branched
/// <see cref="NodeResult"/> with a <c>BranchPath</c> ending in <c>&lt;groupId&gt;#&lt;n&gt;</c>
/// segments. The root <c>NodeResult</c> for a fan-out node is left as <see cref="NodeStatus.Skipped"/>
/// so the canvas treats it as a dispatch placeholder.
/// </summary>
public class ExecutionGroupTests : IClassFixture<SampleWebApplicationFactory>
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) }
    };

    private readonly SampleWebApplicationFactory _factory;
    public ExecutionGroupTests(SampleWebApplicationFactory factory) => _factory = factory;

    [Fact]
    public async Task Group_replays_node_N_times_with_mutated_body()
    {
        var client = _factory.CreateClient();

        const string scenarioId = "stress-create-user";
        var scenarioJson = $$"""
        {
            "id": "{{scenarioId}}",
            "name": "Create user 5x with mutated name",
            "nodes": [
                {
                    "id": "create",
                    "method": "POST",
                    "path": "/users",
                    "body": { "name": "seed" }
                }
            ],
            "edges": [],
            "groups": [
                {
                    "id": "loop",
                    "nodeIds": ["create"],
                    "repeat": { "count": 5 },
                    "mutations": [
                        {
                            "nodeId": "create",
                            "field": "body.name",
                            "rule": { "cat": ["user-", { "var": "iteration" }] }
                        }
                    ]
                }
            ]
        }
        """;
        (await client.PutAsync($"/apicover/api/scenarios/{scenarioId}",
            new StringContent(scenarioJson, System.Text.Encoding.UTF8, "application/json")))
            .EnsureSuccessStatusCode();

        var startResponse = await client.PostAsync(
            $"/apicover/api/scenarios/{scenarioId}/runs",
            JsonContent.Create(new { breakpointsEnabled = false }, options: Json));
        startResponse.EnsureSuccessStatusCode();
        var startedRun = (await startResponse.Content.ReadFromJsonAsync<Run>(Json))!;

        var run = await PollUntilFinished(client, startedRun.Id);
        Assert.Equal(RunStatus.Succeeded, run.Status);

        // Root NodeResult is a dispatch placeholder; per-iter branch records carry the data.
        var rootCreate = run.GetResult("create", BranchPath.Root)!;
        Assert.Equal(NodeStatus.Skipped, rootCreate.Status);

        for (var i = 1; i <= 5; i++)
        {
            var iterPath = new BranchPath(new[] { $"loop#{i}" });
            var it = run.GetResult("create", iterPath);
            Assert.NotNull(it);
            Assert.Equal(NodeStatus.Succeeded, it!.Status);
            var name = it.Request!.Body!["name"]!.GetValue<string>();
            Assert.Equal($"user-{i}", name);
        }
    }

    [Fact]
    public async Task Two_overlapping_groups_run_cartesian_product()
    {
        var client = _factory.CreateClient();

        const string scenarioId = "stress-cartesian";
        // 2 groups × 3 group → 2*3 = 6 iterations on the single shared node.
        var scenarioJson = $$"""
        {
            "id": "{{scenarioId}}",
            "name": "Cartesian groups",
            "nodes": [
                { "id": "create", "method": "POST", "path": "/users", "body": { "name": "x" } }
            ],
            "edges": [],
            "groups": [
                {
                    "id": "outer", "nodeIds": ["create"],
                    "repeat": { "count": 2 },
                    "mutations": [{
                        "nodeId": "create", "field": "body.name",
                        "rule": { "cat": ["o", { "var": "groups.outer.iteration" }, "-i", { "var": "groups.inner.iteration" }] }
                    }]
                },
                {
                    "id": "inner", "nodeIds": ["create"],
                    "repeat": { "count": 3 }
                }
            ]
        }
        """;
        (await client.PutAsync($"/apicover/api/scenarios/{scenarioId}",
            new StringContent(scenarioJson, System.Text.Encoding.UTF8, "application/json")))
            .EnsureSuccessStatusCode();

        var startResponse = await client.PostAsync(
            $"/apicover/api/scenarios/{scenarioId}/runs",
            JsonContent.Create(new { breakpointsEnabled = false }, options: Json));
        startResponse.EnsureSuccessStatusCode();
        var startedRun = (await startResponse.Content.ReadFromJsonAsync<Run>(Json))!;

        var run = await PollUntilFinished(client, startedRun.Id);
        Assert.Equal(RunStatus.Succeeded, run.Status);

        // Root is a placeholder; per-iter records carry data, branchPath contains BOTH groups
        // (in nodeGroups order — outer, then inner) so cartesian iterations stay distinguishable.
        var root = run.GetResult("create", BranchPath.Root)!;
        Assert.Equal(NodeStatus.Skipped, root.Status);

        var iterRecords = run.NodeResults
            .Where(r => r.NodeId == "create" && r.BranchPath.Count == 2)
            .ToList();
        Assert.Equal(6, iterRecords.Count);

        // Innermost varies fastest → ordering by BranchPath ascending should give us
        // (o1,i1), (o1,i2), (o1,i3), (o2,i1), (o2,i2), (o2,i3).
        var names = iterRecords
            .OrderBy(r => string.Join("/", r.BranchPath))
            .Select(r => r.Request!.Body!["name"]!.GetValue<string>())
            .ToList();
        Assert.Equal(new[] { "o1-i1", "o1-i2", "o1-i3", "o2-i1", "o2-i2", "o2-i3" }, names);
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
            await Task.Delay(50);
        }
        throw new TimeoutException($"Run {runId} did not finish within 15s.");
    }
}
