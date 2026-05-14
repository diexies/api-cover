using System.ComponentModel;
using System.Text.Json;
using ModelContextProtocol.Server;
using APICover.Abstractions.Models;
using APICover.Abstractions.Services;
using APICover.Abstractions.Validation;

namespace APICover.Mcp.Tools;

[McpServerToolType]
public static class ScenariosTools
{
    [McpServerTool(Name = "scenarios.list")]
    [Description("WHEN: user asks what scenarios exist, or before authoring to avoid duplicates.\n\nList all scenarios as id+name+nodeCount summaries.")]
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
    [Description("WHEN: user wants the full body of a specific scenario or needs node/edge details to reason about it.\n\nFetch the full Scenario document by id, including nodes, edges, breakpoints and groups.")]
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
    [Description("WHEN: authoring or updating a scenario from natural-language intent — call after deciding DAG shape, never before.\n\nCreate or replace a scenario. Pass the full Scenario JSON object (id, name, nodes[], edges[]). Validates id matches ^[a-z0-9-]+$ and every edge endpoint exists in nodes[].")]
    public static async Task<object> Save(
        IScenarioStore store,
        [Description("Scenario JSON object. Top-level fields: id, name, description?, tags?, nodes[], edges[], startNodeIds?, breakpoints?, groups?, caseSets?")] JsonElement scenario,
        CancellationToken ct)
    {
        // Some MCP clients (notably Claude Code) serialise object arguments as JSON-encoded
        // strings when the param schema doesn't pin a type. Accept both shapes: parse the
        // string into a JsonElement first if needed.
        var payload = scenario;
        if (payload.ValueKind == JsonValueKind.String)
        {
            var raw = payload.GetString();
            if (string.IsNullOrWhiteSpace(raw))
            {
                return new { ok = false, errors = new[] { "scenario payload is an empty string." } };
            }
            try
            {
                using var doc = JsonDocument.Parse(raw);
                payload = doc.RootElement.Clone();
            }
            catch (JsonException ex)
            {
                return new { ok = false, errors = new[] { $"scenario payload is not valid JSON: {ex.Message}" } };
            }
        }
        if (payload.ValueKind != JsonValueKind.Object)
        {
            return new { ok = false, errors = new[] { $"scenario payload must be a JSON object, got {payload.ValueKind}." } };
        }

        Scenario? parsed = null;
        try
        {
            parsed = payload.Deserialize<Scenario>(McpJson.Options);
        }
        catch (JsonException ex)
        {
            return new { ok = false, errors = new[] { $"scenario payload failed to deserialise: {ex.Message}" } };
        }
        if (parsed is null)
        {
            return new { ok = false, errors = new[] { "scenario payload deserialised to null." } };
        }

        var validation = ScenarioValidator.Validate(parsed);
        if (!validation.IsValid)
        {
            return new { ok = false, errors = validation.Errors.ToArray() };
        }

        await store.SaveAsync(parsed, ct);
        return new { ok = true, id = parsed.Id, nodeCount = parsed.Nodes.Count, edgeCount = parsed.Edges.Count };
    }

    [McpServerTool(Name = "scenarios.delete")]
    [Description("WHEN: user explicitly asks to remove a scenario, or cleanup after a failed save.\n\nPermanently delete a scenario by id.")]
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
    [Description("WHEN: user asks to execute or rerun a scenario; do not call to inspect history (use runs.list instead).\n\nStart a new run for the given scenario. Returns immediately with the runId; status begins at \"running\". Use runs.subscribe(runId) to stream events or runs.get(runId) to poll the snapshot.")]
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
