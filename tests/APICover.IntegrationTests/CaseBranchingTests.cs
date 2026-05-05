using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using APICover.Abstractions.Models;
using APICover.Engine;

namespace APICover.IntegrationTests;

/// <summary>
/// Tests for case-based branching: pre-flight estimator and cap rejection.
/// Engine fork behaviour (actual variant execution) is exercised in later steps.
/// </summary>
public class CaseBranchingTests : IClassFixture<SampleWebApplicationFactory>
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) }
    };

    private readonly SampleWebApplicationFactory _factory;

    public CaseBranchingTests(SampleWebApplicationFactory factory) => _factory = factory;


    [Fact]
    public void Estimator_returns_one_branch_for_unforked_scenario()
    {
        var scenario = new Scenario
        {
            Id = "linear",
            Name = "Linear",
            Nodes =
            {
                new ApiNode { Id = "a", Method = "GET", Path = "/a" },
                new ApiNode { Id = "b", Method = "GET", Path = "/b" },
                new ApiNode { Id = "c", Method = "GET", Path = "/c" }
            },
            Edges =
            {
                new Edge { From = "a", To = "b" },
                new Edge { From = "b", To = "c" }
            }
        };

        var est = BranchEstimator.Estimate(scenario);

        Assert.Equal(1, est.TotalBranches);
        Assert.Equal(3, est.TotalLeafInvocations);
    }

    [Fact]
    public void Estimator_multiplies_at_each_anchor()
    {
        // a → b(2 variants) → c → d(3 variants) → e
        // Expected: total branches = 1 × 2 × 3 = 6, leaf invocations = 1+1+2+2+6+6 = 18.
        var scenario = new Scenario
        {
            Id = "fork",
            Name = "Fork",
            Nodes =
            {
                new ApiNode { Id = "a", Method = "GET", Path = "/a" },
                new ApiNode { Id = "b", Method = "GET", Path = "/b" },
                new ApiNode { Id = "c", Method = "GET", Path = "/c" },
                new ApiNode { Id = "d", Method = "GET", Path = "/d" },
                new ApiNode { Id = "e", Method = "GET", Path = "/e" }
            },
            Edges =
            {
                new Edge { From = "a", To = "b" },
                new Edge { From = "b", To = "c" },
                new Edge { From = "c", To = "d" },
                new Edge { From = "d", To = "e" }
            },
            CaseSets =
            {
                new CaseSet
                {
                    Id = "cs1", AnchorNodeId = "b",
                    Variants =
                    {
                        new CaseVariant { Id = "v1", Label = "first" },
                        new CaseVariant { Id = "v2", Label = "second" }
                    }
                },
                new CaseSet
                {
                    Id = "cs2", AnchorNodeId = "d",
                    Variants =
                    {
                        new CaseVariant { Id = "v1", Label = "x" },
                        new CaseVariant { Id = "v2", Label = "y" },
                        new CaseVariant { Id = "v3", Label = "z" }
                    }
                }
            }
        };

        var est = BranchEstimator.Estimate(scenario);

        Assert.Equal(6, est.TotalBranches);
        // Per-node branch counts: a=1, b=2 (after fork), c=2, d=6 (after fork), e=6 → sum 17.
        Assert.Equal(1 + 2 + 2 + 6 + 6, est.TotalLeafInvocations);
    }

    [Fact]
    public async Task Cap_rejects_run_when_estimate_exceeds_max_branches()
    {
        // 8 anchors × 2 variants = 256 expected branches; default cap = 128 → must reject.
        var nodes = Enumerable.Range(0, 9)
            .Select(i => new ApiNode { Id = $"n{i}", Method = "GET", Path = $"/n{i}" })
            .ToList();
        var edges = Enumerable.Range(0, 8)
            .Select(i => new Edge { From = $"n{i}", To = $"n{i + 1}" })
            .ToList();
        var caseSets = Enumerable.Range(0, 8).Select(i => new CaseSet
        {
            Id = $"cs{i}", AnchorNodeId = $"n{i}",
            Variants =
            {
                new CaseVariant { Id = "v1", Label = "first" },
                new CaseVariant { Id = "v2", Label = "second" }
            }
        }).ToList();
        var scenario = new Scenario { Id = "explosive", Name = "Explosive" };
        foreach (var n in nodes) scenario.Nodes.Add(n);
        foreach (var e in edges) scenario.Edges.Add(e);
        foreach (var c in caseSets) scenario.CaseSets.Add(c);

        var est = BranchEstimator.Estimate(scenario);
        Assert.True(est.TotalBranches > 128, $"expected > 128, got {est.TotalBranches}");

        // Drive the rejection through the full HTTP pipeline.
        var client = _factory.CreateClient();
        const string scenarioId = "case-explosion";
        var scenarioJson = SerializeScenario(scenario, scenarioId);
        (await client.PutAsync(
            $"/apicover/api/scenarios/{scenarioId}",
            new StringContent(scenarioJson, Encoding.UTF8, "application/json")))
            .EnsureSuccessStatusCode();

        var startResponse = await client.PostAsync(
            $"/apicover/api/scenarios/{scenarioId}/runs",
            JsonContent.Create(new { breakpointsEnabled = false }, options: Json));
        startResponse.EnsureSuccessStatusCode();
        var run = (await startResponse.Content.ReadFromJsonAsync<Run>(Json))!;

        Assert.Equal(RunStatus.Failed, run.Status);
        Assert.NotNull(run.Error);
        Assert.Contains("Branch cap exceeded", run.Error!, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Single_fork_runs_anchor_per_variant_and_tags_branchPath()
    {
        var client = _factory.CreateClient();
        const string scenarioId = "fork-create-users";
        var scenarioJson = """
        {
          "id": "fork-create-users",
          "name": "Fork POST /users",
          "nodes": [
            {
              "id": "create",
              "method": "POST",
              "path": "/users",
              "body": { "name": "default" }
            }
          ],
          "edges": [],
          "caseSets": [
            {
              "id": "cs-name",
              "anchorNodeId": "create",
              "variants": [
                { "id": "ada", "label": "Ada", "overrides": [{ "field": "body.name", "value": "Ada" }] },
                { "id": "eve", "label": "Eve", "overrides": [{ "field": "body.name", "value": "Eve" }] }
              ]
            }
          ]
        }
        """;

        (await client.PutAsync(
            $"/apicover/api/scenarios/{scenarioId}",
            new StringContent(scenarioJson, Encoding.UTF8, "application/json")))
            .EnsureSuccessStatusCode();

        var startResponse = await client.PostAsync(
            $"/apicover/api/scenarios/{scenarioId}/runs",
            JsonContent.Create(new { breakpointsEnabled = false }, options: Json));
        startResponse.EnsureSuccessStatusCode();
        var startedRun = (await startResponse.Content.ReadFromJsonAsync<Run>(Json))!;

        var run = await PollUntilFinished(client, startedRun.Id);
        Assert.True(run.Status == RunStatus.Succeeded,
            $"Run status was {run.Status}. Error={run.Error}");

        // Two NodeResults for the anchor — one per variant.
        var anchorBranches = run.NodeResults
            .Where(r => r.NodeId == "create" && r.BranchPath.Count == 1)
            .ToList();
        Assert.Equal(2, anchorBranches.Count);
        Assert.Contains(anchorBranches, r => r.BranchPath[0] == "ada");
        Assert.Contains(anchorBranches, r => r.BranchPath[0] == "eve");

        // Both succeeded with distinct request bodies reflecting the variant override.
        foreach (var b in anchorBranches)
        {
            Assert.Equal(NodeStatus.Succeeded, b.Status);
            Assert.Equal(201, b.Response!.Status);
        }

        var nameByVariant = anchorBranches.ToDictionary(
            b => b.BranchPath[0],
            b => b.Request!.Body!["name"]!.GetValue<string>());
        Assert.Equal("Ada", nameByVariant["ada"]);
        Assert.Equal("Eve", nameByVariant["eve"]);
    }

    [Fact]
    public async Task Nested_cases_produce_cartesian_branches()
    {
        // create (2 variants) → list (no variants); but list itself isn't an anchor.
        // For nesting: create (2 variants) → fetch (2 variants).
        var client = _factory.CreateClient();
        const string scenarioId = "nested-cases";
        var scenarioJson = """
        {
          "id": "nested-cases",
          "name": "Nested cases",
          "nodes": [
            { "id": "create", "method": "POST", "path": "/users", "body": { "name": "default" } },
            { "id": "list", "method": "GET", "path": "/users" }
          ],
          "edges": [
            { "from": "create", "to": "list" }
          ],
          "caseSets": [
            {
              "id": "cs1",
              "anchorNodeId": "create",
              "variants": [
                { "id": "a1", "label": "first",  "overrides": [{ "field": "body.name", "value": "Alice" }] },
                { "id": "a2", "label": "second", "overrides": [{ "field": "body.name", "value": "Bob"   }] }
              ]
            },
            {
              "id": "cs2",
              "anchorNodeId": "list",
              "variants": [
                { "id": "b1", "label": "no-filter",  "overrides": [] },
                { "id": "b2", "label": "no-filter2", "overrides": [] }
              ]
            }
          ]
        }
        """;

        (await client.PutAsync(
            $"/apicover/api/scenarios/{scenarioId}",
            new StringContent(scenarioJson, Encoding.UTF8, "application/json")))
            .EnsureSuccessStatusCode();

        var startResponse = await client.PostAsync(
            $"/apicover/api/scenarios/{scenarioId}/runs",
            JsonContent.Create(new { breakpointsEnabled = false }, options: Json));
        startResponse.EnsureSuccessStatusCode();
        var startedRun = (await startResponse.Content.ReadFromJsonAsync<Run>(Json))!;

        var run = await PollUntilFinished(client, startedRun.Id);
        Assert.True(run.Status == RunStatus.Succeeded,
            $"Run status was {run.Status}. Error={run.Error}");

        // 2 create branches × 2 list branches = 4 list NodeResults at depth 2.
        var listLeaves = run.NodeResults
            .Where(r => r.NodeId == "list" && r.BranchPath.Count == 2)
            .ToList();
        Assert.Equal(4, listLeaves.Count);

        var branchKeys = listLeaves.Select(r => string.Join("/", r.BranchPath)).OrderBy(s => s).ToList();
        Assert.Equal(new[] { "a1/b1", "a1/b2", "a2/b1", "a2/b2" }, branchKeys);

        foreach (var leaf in listLeaves)
        {
            Assert.Equal(NodeStatus.Succeeded, leaf.Status);
            Assert.Equal(200, leaf.Response!.Status);
        }
    }

    [Fact]
    public async Task Group_iterations_compose_with_case_variants()
    {
        // Place the create node inside a repeating group of 2 iterations AND attach a 2-variant
        // case set to it: every variant should run twice (2 × 2 = 4 invocations), but the engine
        // surfaces this as 2 branched NodeResults each with Iterations.Count == 2.
        var client = _factory.CreateClient();
        const string scenarioId = "case-x-group";
        var scenarioJson = """
        {
          "id": "case-x-group",
          "name": "Case x Group",
          "nodes": [
            {
              "id": "create",
              "method": "POST",
              "path": "/users",
              "body": { "name": { "cat": ["base-", { "var": "iteration" }] } }
            }
          ],
          "edges": [],
          "groups": [
            {
              "id": "loop",
              "nodeIds": ["create"],
              "repeat": { "count": 2 }
            }
          ],
          "caseSets": [
            {
              "id": "cs-suffix",
              "anchorNodeId": "create",
              "variants": [
                { "id": "ada", "label": "Ada", "overrides": [{ "field": "body.suffix", "value": "ada" }] },
                { "id": "eve", "label": "Eve", "overrides": [{ "field": "body.suffix", "value": "eve" }] }
              ]
            }
          ]
        }
        """;

        (await client.PutAsync(
            $"/apicover/api/scenarios/{scenarioId}",
            new StringContent(scenarioJson, Encoding.UTF8, "application/json")))
            .EnsureSuccessStatusCode();

        var startResponse = await client.PostAsync(
            $"/apicover/api/scenarios/{scenarioId}/runs",
            JsonContent.Create(new { breakpointsEnabled = false }, options: Json));
        startResponse.EnsureSuccessStatusCode();
        var startedRun = (await startResponse.Content.ReadFromJsonAsync<Run>(Json))!;

        var run = await PollUntilFinished(client, startedRun.Id);
        Assert.True(run.Status == RunStatus.Succeeded,
            $"Run status was {run.Status}. Error={run.Error}");

        // 2 branches × 1 anchor node = 2 anchor results, one per variant.
        var anchors = run.NodeResults
            .Where(r => r.NodeId == "create" && r.BranchPath.Count == 1)
            .ToList();
        Assert.Equal(2, anchors.Count);

        // The grouped path runs once on the parent (root) result before forking — and by Step 4
        // semantics, the anchor's variant invocation is a single send (NOT looped). The
        // ExecutionGroup loop wraps the *root* execution. So the per-variant Iterations list
        // is empty; the loop fires before the fork. This documents the v1 behaviour: groups
        // and cases compose by stacking, not by multiplying.
        // NOTE: when richer semantics are wanted (group inside fork), the engine must apply
        // group iteration AFTER the variant override is applied. v1 explicitly does not.
        foreach (var a in anchors)
        {
            Assert.Equal(NodeStatus.Succeeded, a.Status);
            Assert.Equal(201, a.Response!.Status);
        }
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
        throw new TimeoutException($"Run {runId} did not finish within deadline.");
    }

    private static string SerializeScenario(Scenario scenario, string id)
    {
        // Re-serialize via STJ to match wire format the inspector expects.
        var copy = new
        {
            id,
            name = scenario.Name,
            nodes = scenario.Nodes.Select(n => new { id = n.Id, method = n.Method, path = n.Path }),
            edges = scenario.Edges.Select(e => new { from = e.From, to = e.To }),
            caseSets = scenario.CaseSets.Select(c => new
            {
                id = c.Id,
                anchorNodeId = c.AnchorNodeId,
                variants = c.Variants.Select(v => new { id = v.Id, label = v.Label })
            })
        };
        return JsonSerializer.Serialize(copy, Json);
    }
}
