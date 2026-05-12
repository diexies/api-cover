using System.ComponentModel;
using System.Text.Json;
using ModelContextProtocol;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;
using APICover.Abstractions.Models;
using APICover.Abstractions.Services;

namespace APICover.Mcp.Tools;

[McpServerToolType]
public static class RunsTools
{
    [McpServerTool(Name = "runs.list")]
    [Description("List recent runs with summary state. Optionally filter by scenario id. Newest first.")]
    public static async Task<object> List(
        IRunStore store,
        [Description("Filter by scenario id.")] string? scenarioId = null,
        [Description("Maximum number of runs to return. Default 50.")] int? take = null,
        CancellationToken ct = default)
    {
        var n = Math.Clamp(take ?? 50, 1, 500);
        var runs = await store.ListAsync(scenarioId, n, ct);
        var arr = runs.Select(r => new
        {
            id = r.Id,
            scenarioId = r.ScenarioId,
            status = r.Status.ToString(),
            startedAt = r.StartedAt,
            completedAt = r.CompletedAt,
            error = r.Error,
            nodeCount = r.NodeResults.Count,
            failedNodeCount = r.NodeResults.Count(n => n.Status == NodeStatus.Failed),
        }).ToArray();
        return new { count = arr.Length, runs = arr };
    }

    [McpServerTool(Name = "runs.list_failed")]
    [Description("List recent runs that contain failed nodes, expanded one row per failure. Returns runId, scenarioId, nodeId, method, path, status code, error. Use this when answering \"which tests are broken right now?\".")]
    public static async Task<object> ListFailed(
        IRunStore runs,
        IScenarioStore scenarios,
        [Description("Filter by scenario id.")] string? scenarioId = null,
        [Description("Maximum number of failed runs to inspect. Default 20.")] int? take = null,
        CancellationToken ct = default)
    {
        var n = Math.Clamp(take ?? 20, 1, 200);
        var allRuns = await runs.ListAsync(scenarioId, n * 4, ct); // over-fetch then filter
        var failedRuns = allRuns
            .Where(r => r.Status == RunStatus.Failed
                || r.NodeResults.Any(nr => nr.Status == NodeStatus.Failed))
            .Take(n)
            .ToArray();

        // Resolve scenario lookups once for node→endpoint mapping.
        var scenarioCache = new Dictionary<string, Scenario?>(StringComparer.Ordinal);
        async Task<Scenario?> GetScenarioAsync(string id)
        {
            if (scenarioCache.TryGetValue(id, out var s)) return s;
            s = await scenarios.GetAsync(id, ct);
            scenarioCache[id] = s;
            return s;
        }

        var rows = new List<object>();
        foreach (var run in failedRuns)
        {
            var scenario = await GetScenarioAsync(run.ScenarioId);
            foreach (var nr in run.NodeResults.Where(n => n.Status == NodeStatus.Failed))
            {
                var node = scenario?.Nodes.FirstOrDefault(n => n.Id == nr.NodeId);
                rows.Add(new
                {
                    runId = run.Id,
                    scenarioId = run.ScenarioId,
                    nodeId = nr.NodeId,
                    method = node?.Method ?? nr.Request?.Method,
                    path = node?.Path ?? nr.Request?.Path,
                    statusCode = nr.Response?.Status,
                    error = nr.Error,
                    branchPath = nr.BranchPath,
                    completedAt = nr.CompletedAt ?? run.CompletedAt,
                });
            }
        }
        return new { count = rows.Count, failures = rows };
    }

    [McpServerTool(Name = "runs.get")]
    [Description("Fetch the full Run snapshot (status, NodeResults with request/response, error text). Use after a run starts to inspect what happened end-to-end.")]
    public static async Task<object> Get(
        IRunStore store,
        [Description("Run id (returned by scenarios.run).")] string id,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(id))
        {
            throw new ArgumentException("Required field 'id' is missing.", nameof(id));
        }
        var run = await store.GetAsync(id, ct);
        return run is null
            ? new { error = $"No run found with id '{id}'." }
            : (object)run;
    }

    [McpServerTool(Name = "runs.timeline")]
    [Description("Compact human-readable timeline of a run: one row per node in execution order, showing method, URL, status code, response body preview, and duration. Use this for a single-shot 'show me what happened' summary instead of pulling the whole Run snapshot. Bodies are truncated to ~400 chars.")]
    public static async Task<object> Timeline(
        IRunStore runs,
        IScenarioStore scenarios,
        [Description("Run id (returned by scenarios.run).")] string id,
        [Description("Max body preview length per node (request/response). Default 400.")] int? bodyPreviewChars = null,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(id))
        {
            return new { error = "Required field 'id' is missing." };
        }
        var run = await runs.GetAsync(id, ct);
        if (run is null) return new { error = $"No run found with id '{id}'." };

        var preview = Math.Clamp(bodyPreviewChars ?? 400, 80, 4000);
        var scenario = await scenarios.GetAsync(run.ScenarioId, ct);
        var nodeOrder = scenario?.Nodes.Select(n => n.Id).ToList() ?? new List<string>();

        static string Truncate(string? s, int max) =>
            string.IsNullOrEmpty(s) ? string.Empty : s.Length <= max ? s : s.Substring(0, max) + "…";

        var rows = run.NodeResults
            .OrderBy(nr => nodeOrder.IndexOf(nr.NodeId) is var idx && idx >= 0 ? idx : int.MaxValue)
            .ThenBy(nr => nr.StartedAt ?? DateTimeOffset.MaxValue)
            .Select(nr => new
            {
                nodeId = nr.NodeId,
                branchPath = nr.BranchPath.Count == 0 ? null : string.Join("/", nr.BranchPath),
                status = nr.Status.ToString(),
                method = nr.Request?.Method,
                url = nr.Request?.Url,
                requestBody = Truncate(nr.Request?.Body?.ToJsonString(), preview),
                responseStatus = nr.Response?.Status,
                responseBody = Truncate(nr.Response?.Body?.ToJsonString(), preview),
                durationMs = nr.Duration?.TotalMilliseconds,
                error = nr.Error,
            })
            .ToArray();

        return new
        {
            runId = run.Id,
            scenarioId = run.ScenarioId,
            status = run.Status.ToString(),
            startedAt = run.StartedAt,
            completedAt = run.CompletedAt,
            error = run.Error,
            nodeCount = rows.Length,
            failedNodeCount = rows.Count(r => r.status == nameof(NodeStatus.Failed)),
            timeline = rows,
        };
    }

    [McpServerTool(Name = "runs.subscribe")]
    [Description("Stream live run lifecycle events (RunStarted, NodeStarted, NodeCompleted, RunFinished, …) as MCP progress notifications until the run terminates. Returns the final Run snapshot.")]
    public static async Task<object> Subscribe(
        IRunStore store,
        IRunEventBus bus,
        IProgress<ProgressNotificationValue> progress,
        [Description("Run id to subscribe to.")] string id,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(id))
        {
            throw new ArgumentException("Required field 'id' is missing.", nameof(id));
        }

        // Replay current state once so a late subscriber sees where the run is.
        var snapshot = await store.GetAsync(id, ct);
        if (snapshot is null)
        {
            return new { error = $"No run found with id '{id}'." };
        }
        progress.Report(new ProgressNotificationValue
        {
            Progress = 0,
            Message = JsonSerializer.Serialize(new
            {
                type = "snapshot",
                run = snapshot,
            }, McpJson.Options),
        });
        if (snapshot.Status is RunStatus.Succeeded or RunStatus.Failed or RunStatus.Cancelled)
        {
            return snapshot;
        }

        var stepCount = 0;
        await foreach (var evt in bus.SubscribeAsync(id, ct))
        {
            stepCount++;
            progress.Report(new ProgressNotificationValue
            {
                Progress = stepCount,
                Message = JsonSerializer.Serialize(new
                {
                    type = evt.Type.ToString(),
                    nodeId = evt.NodeId,
                    branchPath = evt.BranchPath,
                    timestamp = evt.Timestamp,
                    payload = evt.Payload,
                }, McpJson.Options),
            });
            if (evt.Type == RunEventType.RunFinished)
            {
                break;
            }
        }

        return await store.GetAsync(id, ct) ?? (object)new { error = "Run vanished mid-stream." };
    }
}
