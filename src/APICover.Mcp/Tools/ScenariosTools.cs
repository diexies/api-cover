using System.ComponentModel;
using System.Text.Json;
using ModelContextProtocol.Server;
using APICover.Abstractions.Models;
using APICover.Abstractions.Services;

namespace APICover.Mcp.Tools;

[McpServerToolType]
public static class ScenariosTools
{
    [McpServerTool(Name = "scenarios.list")]
    [Description("List all scenarios as id+name+nodeCount summaries.")]
    public static async Task<object> List(IScenarioStore store, CancellationToken ct)
    {
        var scenarios = await store.ListAsync(ct);
        var arr = scenarios.Select(s => new
        {
            id = s.Id,
            name = s.Name,
            description = s.Description,
            nodeCount = s.Nodes.Count,
            edgeCount = s.Edges.Count,
            tags = s.Tags,
        }).ToArray();
        return new { count = arr.Length, scenarios = arr };
    }

    [McpServerTool(Name = "scenarios.get")]
    [Description("Fetch the full Scenario document by id, including nodes, edges, breakpoints and groups.")]
    public static async Task<object> Get(
        IScenarioStore store,
        [Description("Scenario id (kebab-case identifier).")] string id,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(id))
        {
            throw new ArgumentException("Required field 'id' is missing.", nameof(id));
        }
        var scenario = await store.GetAsync(id, ct);
        return scenario is null
            ? new { error = $"No scenario found with id '{id}'." }
            : (object)scenario;
    }

    [McpServerTool(Name = "scenarios.save")]
    [Description("Create or replace a scenario. Pass the full Scenario JSON (id, name, nodes[], edges[]). Validates that id matches ^[a-z0-9-]+$ and every edge endpoint exists in nodes[].")]
    public static async Task<object> Save(
        IScenarioStore store,
        [Description("Scenario JSON. Top-level fields: id, name, description?, tags?, nodes[], edges[], startNodeIds?, breakpoints?, groups?, caseSets?")] JsonElement scenario,
        CancellationToken ct)
    {
        Scenario parsed;
        try
        {
            parsed = scenario.Deserialize<Scenario>(McpJson.Options)
                ?? throw new ArgumentException("scenario payload is null.");
        }
        catch (JsonException ex)
        {
            throw new ArgumentException($"scenario payload is not a valid Scenario JSON: {ex.Message}");
        }

        if (string.IsNullOrWhiteSpace(parsed.Id) ||
            !System.Text.RegularExpressions.Regex.IsMatch(parsed.Id, "^[a-z0-9-]+$"))
        {
            throw new ArgumentException("Scenario id must match ^[a-z0-9-]+$.");
        }
        if (parsed.Nodes.Count == 0)
        {
            throw new ArgumentException("Scenario must contain at least one node.");
        }
        var nodeIds = parsed.Nodes.Select(n => n.Id).ToHashSet(StringComparer.Ordinal);
        foreach (var edge in parsed.Edges)
        {
            if (!nodeIds.Contains(edge.From))
            {
                throw new ArgumentException($"Edge.from references unknown node '{edge.From}'.");
            }
            if (!nodeIds.Contains(edge.To))
            {
                throw new ArgumentException($"Edge.to references unknown node '{edge.To}'.");
            }
        }

        await store.SaveAsync(parsed, ct);
        return new { ok = true, id = parsed.Id, nodeCount = parsed.Nodes.Count };
    }

    [McpServerTool(Name = "scenarios.delete")]
    [Description("Permanently delete a scenario by id.")]
    public static async Task<object> Delete(
        IScenarioStore store,
        [Description("Scenario id to delete.")] string id,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(id))
        {
            throw new ArgumentException("Required field 'id' is missing.", nameof(id));
        }
        await store.DeleteAsync(id, ct);
        return new { ok = true, id };
    }

    [McpServerTool(Name = "scenarios.run")]
    [Description("Start a new run for the given scenario. Returns immediately with the runId; status begins at \"running\". Use runs.subscribe(runId) to stream events or runs.get(runId) to poll the snapshot.")]
    public static async Task<object> Run(
        IScenarioStore store,
        IScenarioEngine engine,
        [Description("Scenario id to execute.")] string id,
        [Description("Run-level headers attached to every outbound HTTP call (overrides node headers).")] Dictionary<string, string>? headers = null,
        [Description("Run-level query parameters merged into every outbound HTTP call.")] Dictionary<string, string>? queryParameters = null,
        [Description("Disable breakpoint pauses. Default true.")] bool? breakpointsEnabled = null,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(id))
        {
            throw new ArgumentException("Required field 'id' is missing.", nameof(id));
        }
        var scenario = await store.GetAsync(id, ct);
        if (scenario is null)
        {
            return new { error = $"No scenario found with id '{id}'." };
        }
        var options = new RunOptions
        {
            Headers = headers,
            QueryParameters = queryParameters,
            BreakpointsEnabled = breakpointsEnabled ?? true,
        };
        var run = await engine.StartAsync(scenario, options, ct);
        return new
        {
            runId = run.Id,
            scenarioId = run.ScenarioId,
            status = run.Status.ToString(),
            startedAt = run.StartedAt,
        };
    }
}
