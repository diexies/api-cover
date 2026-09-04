using System.Text.Json;
using System.Text.Json.Nodes;
using APICover.Abstractions.Discovery;
using APICover.Abstractions.Models;
using APICover.Abstractions.Services;
using APICover.Abstractions.Validation;
using APICover.Agent.Memory;
using APICover.Discovery.CallGraph;

namespace APICover.Agent.Tools;

/// <summary>
/// Server-side handler for tool-use blocks. The agent's outer loop receives a tool_use
/// from Claude, calls <see cref="DispatchAsync"/>, and feeds the result back as a
/// tool_result block. Pure data lookup — no side effects, no further LLM calls.
/// </summary>
public sealed class ToolDispatcher
{
    private readonly IEndpointDiscoveryService _discovery;
    private readonly IAgentMemoryStore _memory;
    private readonly IScenarioStore _scenarios;
    private readonly ICustomToolInvoker? _customInvoker;
    private readonly ICommunityContextService? _communities;
    private readonly IScenarioEngine? _engine;
    private readonly IRunStore? _runs;

    private static readonly JsonSerializerOptions ScenarioJsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true
    };

    public ToolDispatcher(
        IEndpointDiscoveryService discovery,
        IAgentMemoryStore memory,
        IScenarioStore scenarios,
        ICustomToolInvoker? customInvoker = null,
        ICommunityContextService? communities = null,
        IScenarioEngine? engine = null,
        IRunStore? runs = null)
    {
        _discovery = discovery;
        _memory = memory;
        _scenarios = scenarios;
        _customInvoker = customInvoker;
        _communities = communities;
        _engine = engine;
        _runs = runs;
    }

    public async Task<ToolResult> DispatchAsync(string toolName, JsonNode? input, CancellationToken cancellationToken)
    {
        try
        {
            JsonNode? output = toolName switch
            {
                ToolRegistry.ListEndpoints => HandleListEndpoints(input),
                ToolRegistry.GetEndpointDetails => HandleGetEndpointDetails(input),
                ToolRegistry.ReadMemory => await HandleReadMemoryAsync(input, cancellationToken),
                ToolRegistry.ListMemory => await HandleListMemoryAsync(input, cancellationToken),
                ToolRegistry.WriteMemory => await HandleWriteMemoryAsync(input, cancellationToken),
                ToolRegistry.AppendMemory => await HandleAppendMemoryAsync(input, cancellationToken),
                ToolRegistry.DeleteMemory => await HandleDeleteMemoryAsync(input, cancellationToken),
                ToolRegistry.SaveScenario => await HandleSaveScenarioAsync(input, cancellationToken),
                ToolRegistry.GetCommunities => await HandleGetCommunitiesAsync(cancellationToken),
                ToolRegistry.GetCommunityContext => await HandleGetCommunityContextAsync(input, cancellationToken),
                ToolRegistry.RunScenario => await HandleRunScenarioAsync(input, cancellationToken),
                ToolRegistry.GetDirtyCommunities => await HandleGetDirtyCommunitiesAsync(input, cancellationToken),
                ToolRegistry.ListScenarios => await HandleListScenariosAsync(cancellationToken),
                ToolRegistry.PlanAdd => await HandlePlanAddAsync(input, cancellationToken),
                ToolRegistry.PlanUpdate => await HandlePlanUpdateAsync(input, cancellationToken),
                ToolRegistry.PlanList => await HandlePlanListAsync(cancellationToken),
                ToolRegistry.DatasetSave => await HandleDatasetSaveAsync(input, cancellationToken),
                ToolRegistry.DatasetList => await HandleDatasetListAsync(cancellationToken),
                ToolRegistry.DatasetRead => await HandleDatasetReadAsync(input, cancellationToken),
                ToolRegistry.PlaygroundStart => await HandlePlaygroundStartAsync(input, cancellationToken),
                ToolRegistry.PlaygroundReset => await HandlePlaygroundResetAsync(cancellationToken),
                _ => null
            };

            if (output is null && _customInvoker is not null)
            {
                output = await _customInvoker.TryInvokeAsync(toolName, input, cancellationToken);
            }

            if (output is null)
            {
                return new ToolResult(
                    JsonValue.Create($"Unknown tool: {toolName}")!,
                    IsError: true);
            }

            return new ToolResult(output, IsError: false);
        }
        catch (Exception ex)
        {
            return new ToolResult(
                JsonValue.Create($"{ex.GetType().Name}: {ex.Message}")!,
                IsError: true);
        }
    }

    private async Task<JsonNode> HandleRunScenarioAsync(JsonNode? input, CancellationToken cancellationToken)
    {
        if (_engine is null || _runs is null)
        {
            return JsonValue.Create("Scenario execution unavailable — engine not registered.")!;
        }
        var id = input?["id"]?.GetValue<string>()?.Trim();
        if (string.IsNullOrEmpty(id))
        {
            return JsonValue.Create("Required field 'id' is missing.")!;
        }
        var scenario = await _scenarios.GetAsync(id, cancellationToken);
        if (scenario is null)
        {
            return JsonValue.Create($"No scenario with id '{id}'. Call save_scenario first.")!;
        }

        var timeout = Math.Clamp(input?["timeoutSeconds"]?.GetValue<int>() ?? 90, 5, 300);
        var started = await _engine.StartAsync(scenario, new RunOptions { BreakpointsEnabled = false }, cancellationToken);

        var deadline = DateTimeOffset.UtcNow.AddSeconds(timeout);
        Run run = started;
        while (run.Status is RunStatus.Pending or RunStatus.Running or RunStatus.Paused)
        {
            if (DateTimeOffset.UtcNow > deadline)
            {
                return JsonSerializer.SerializeToNode(new
                {
                    runId = started.Id,
                    status = "timeout",
                    detail = $"Run did not finish within {timeout}s. Inspect it in the UI or retry with a larger timeoutSeconds.",
                }, ScenarioJsonOptions)!;
            }
            await Task.Delay(500, cancellationToken);
            run = await _runs.GetAsync(started.Id, cancellationToken) ?? run;
        }

        var failed = run.NodeResults
            .Where(r => r.Status is NodeStatus.Failed or NodeStatus.Cancelled)
            .Select(r => new
            {
                nodeId = r.NodeId,
                branchPath = r.BranchPath,
                status = r.Status.ToString(),
                httpStatus = r.Response?.Status,
                error = r.Error,
                responseBodySample = Truncate(r.Response?.Body?.ToJsonString(), 400),
            })
            .ToArray();

        return JsonSerializer.SerializeToNode(new
        {
            runId = run.Id,
            status = run.Status.ToString(),
            error = run.Error,
            totalNodeResults = run.NodeResults.Count,
            succeeded = run.NodeResults.Count(r => r.Status == NodeStatus.Succeeded),
            failedCount = failed.Length,
            failed,
            hint = failed.Length > 0
                ? "Triage each failure: 5xx = suspected server bug; unexpected 2xx on invalid input = validation gap; created-but-not-readable = read-after-write violation. Record real findings to memory under findings/."
                : "All branches passed. If variants were meant to be rejected (4xx) but show succeeded here, check whether the API accepted invalid input — that is a finding too.",
        }, ScenarioJsonOptions)!;
    }

    private static string? Truncate(string? s, int max)
        => s is null ? null : s.Length <= max ? s : s[..max] + "…";

    /* ─── Plan: persistent agent-internal task list (plan/tasks.json) ─────── */

    private const string PlanPath = "plan/tasks.json";
    private const string PlaygroundPath = "playground/current.json";

    private async Task<JsonObject> ReadPlanAsync(CancellationToken ct)
    {
        var raw = await _memory.ReadAsync(PlanPath, ct);
        if (raw is not null)
        {
            try { if (JsonNode.Parse(raw) is JsonObject o) return o; } catch { /* corrupt — reinit */ }
        }
        return new JsonObject { ["nextId"] = 1, ["tasks"] = new JsonArray() };
    }

    private async Task<JsonNode> HandlePlanAddAsync(JsonNode? input, CancellationToken ct)
    {
        var title = input?["title"]?.GetValue<string>()?.Trim();
        if (string.IsNullOrEmpty(title)) return JsonValue.Create("Required field 'title' is missing.")!;
        var plan = await ReadPlanAsync(ct);
        var id = plan["nextId"]!.GetValue<int>();
        var task = new JsonObject
        {
            ["id"] = id,
            ["title"] = title,
            ["detail"] = input?["detail"]?.GetValue<string>(),
            ["status"] = "pending",
            ["updatedAt"] = DateTimeOffset.UtcNow.ToString("O"),
        };
        plan["tasks"]!.AsArray().Add(task);
        plan["nextId"] = id + 1;
        await _memory.WriteAsync(PlanPath, plan.ToJsonString(ScenarioJsonOptions), ct);
        return task.DeepClone();
    }

    private async Task<JsonNode> HandlePlanUpdateAsync(JsonNode? input, CancellationToken ct)
    {
        var id = input?["id"]?.GetValue<int>() ?? -1;
        var status = input?["status"]?.GetValue<string>();
        if (id < 0 || status is not ("pending" or "in_progress" or "done" or "blocked"))
        {
            return JsonValue.Create("Required: id (int) + status (pending|in_progress|done|blocked).")!;
        }
        var plan = await ReadPlanAsync(ct);
        var task = plan["tasks"]!.AsArray().FirstOrDefault(t => t?["id"]?.GetValue<int>() == id);
        if (task is null) return JsonValue.Create($"No plan task with id {id}. Call plan_list.")!;
        task["status"] = status;
        if (input?["detail"]?.GetValue<string>() is { Length: > 0 } detail) task["detail"] = detail;
        task["updatedAt"] = DateTimeOffset.UtcNow.ToString("O");
        await _memory.WriteAsync(PlanPath, plan.ToJsonString(ScenarioJsonOptions), ct);
        return task.DeepClone();
    }

    private async Task<JsonNode> HandlePlanListAsync(CancellationToken ct)
    {
        var plan = await ReadPlanAsync(ct);
        var tasks = plan["tasks"]!.AsArray();
        return new JsonObject
        {
            ["count"] = tasks.Count,
            ["open"] = tasks.Count(t => t?["status"]?.GetValue<string>() is "pending" or "in_progress" or "blocked"),
            ["tasks"] = tasks.DeepClone(),
        };
    }

    /* ─── Datasets: experiment data under datasets/<name>.json ────────────── */

    private async Task<JsonNode> HandleDatasetSaveAsync(JsonNode? input, CancellationToken ct)
    {
        var name = Slug(input?["name"]?.GetValue<string>());
        if (name.Length == 0) return JsonValue.Create("Required field 'name' is missing.")!;
        if (input?["records"] is not JsonArray records || records.Count == 0)
        {
            return JsonValue.Create("Required field 'records' must be a non-empty JSON array.")!;
        }
        await _memory.WriteAsync($"datasets/{name}.json", records.ToJsonString(ScenarioJsonOptions), ct);
        return new JsonObject
        {
            ["name"] = name,
            ["recordCount"] = records.Count,
            ["fields"] = new JsonArray((records[0] as JsonObject)?.Select(kv => (JsonNode)JsonValue.Create(kv.Key)!).ToArray() ?? Array.Empty<JsonNode>()),
        };
    }

    private async Task<JsonNode> HandleDatasetListAsync(CancellationToken ct)
    {
        var entries = await _memory.ListAsync("datasets/", ct);
        var items = new JsonArray();
        foreach (var e in entries)
        {
            var raw = await _memory.ReadAsync(e.Path, ct);
            var arr = raw is null ? null : JsonNode.Parse(raw) as JsonArray;
            items.Add(new JsonObject
            {
                ["name"] = System.IO.Path.GetFileNameWithoutExtension(e.Path),
                ["recordCount"] = arr?.Count ?? 0,
                ["fields"] = new JsonArray((arr?.FirstOrDefault() as JsonObject)?.Select(kv => (JsonNode)JsonValue.Create(kv.Key)!).ToArray() ?? Array.Empty<JsonNode>()),
            });
        }
        return new JsonObject { ["count"] = items.Count, ["datasets"] = items };
    }

    private async Task<JsonNode> HandleDatasetReadAsync(JsonNode? input, CancellationToken ct)
    {
        var name = Slug(input?["name"]?.GetValue<string>());
        var raw = await _memory.ReadAsync($"datasets/{name}.json", ct);
        if (raw is null) return JsonValue.Create($"No dataset '{name}'. Call dataset_list.")!;
        var records = JsonNode.Parse(raw)!.AsArray();
        var offset = Math.Max(0, input?["offset"]?.GetValue<int>() ?? 0);
        var limit = Math.Clamp(input?["limit"]?.GetValue<int>() ?? 20, 1, 100);
        var page = new JsonArray(records.Skip(offset).Take(limit).Select(r => r!.DeepClone()).ToArray());
        return new JsonObject
        {
            ["name"] = name,
            ["total"] = records.Count,
            ["offset"] = offset,
            ["limit"] = limit,
            ["records"] = page,
        };
    }

    /* ─── Playground: disposable experiment workspace ─────────────────────── */

    private async Task<JsonNode> HandlePlaygroundStartAsync(JsonNode? input, CancellationToken ct)
    {
        var name = Slug(input?["name"]?.GetValue<string>());
        if (name.Length == 0) return JsonValue.Create("Required field 'name' is missing.")!;
        var existing = await _memory.ReadAsync(PlaygroundPath, ct);
        if (existing is not null)
        {
            return JsonValue.Create("A playground is already active. Call playground_reset first, or continue using its scenarioPrefix.")!;
        }
        var doc = new JsonObject
        {
            ["name"] = name,
            ["scenarioPrefix"] = $"pg-{name}-",
            ["startedAt"] = DateTimeOffset.UtcNow.ToString("O"),
        };
        await _memory.WriteAsync(PlaygroundPath, doc.ToJsonString(ScenarioJsonOptions), ct);
        doc["instruction"] = "Every experiment scenario id MUST start with scenarioPrefix; playground_reset wipes exactly those.";
        return doc;
    }

    private async Task<JsonNode> HandlePlaygroundResetAsync(CancellationToken ct)
    {
        var raw = await _memory.ReadAsync(PlaygroundPath, ct);
        if (raw is null) return JsonValue.Create("No active playground.")!;
        var doc = JsonNode.Parse(raw)!.AsObject();
        var prefix = doc["scenarioPrefix"]!.GetValue<string>();
        var deleted = new JsonArray();
        foreach (var s in await _scenarios.ListAsync(ct))
        {
            if (!s.Id.StartsWith(prefix, StringComparison.Ordinal)) continue;
            await _scenarios.DeleteAsync(s.Id, ct);
            deleted.Add(s.Id);
        }
        await _memory.DeleteAsync(PlaygroundPath, ct);
        return new JsonObject
        {
            ["name"] = doc["name"]!.DeepClone(),
            ["deletedScenarioCount"] = deleted.Count,
            ["deletedScenarioIds"] = deleted,
            ["note"] = "Datasets and memory files were kept.",
        };
    }

    private static string Slug(string? s)
    {
        if (string.IsNullOrWhiteSpace(s)) return string.Empty;
        var chars = s.Trim().ToLowerInvariant()
            .Select(c => char.IsLetterOrDigit(c) ? c : '-')
            .ToArray();
        var slug = new string(chars);
        while (slug.Contains("--")) slug = slug.Replace("--", "-");
        return slug.Trim('-');
    }

    private async Task<JsonNode> HandleListScenariosAsync(CancellationToken cancellationToken)
    {
        var scenarios = await _scenarios.ListAsync(cancellationToken);
        var items = scenarios.Select(s => new
        {
            id = s.Id,
            name = s.Name,
            description = Truncate(s.Description, 240),
            tags = s.Tags,
            nodeChain = s.Nodes.Select(n => $"{n.Method} {n.Path}").ToArray(),
            caseSetCount = s.CaseSets.Count,
            updatedAt = s.UpdatedAt,
        }).ToArray();
        return JsonSerializer.SerializeToNode(new { count = items.Length, scenarios = items }, ScenarioJsonOptions)!;
    }

    private async Task<JsonNode> HandleGetDirtyCommunitiesAsync(JsonNode? input, CancellationToken cancellationToken)
    {
        if (_communities is null)
        {
            return JsonValue.Create("Community context unavailable — call AddAPICover() before AddAPICoverAgent().")!;
        }
        var sinceSha = input?["sinceSha"]?.GetValue<string>() ?? string.Empty;
        var result = await _communities.GetDirtyCommunitiesAsync(sinceSha, cancellationToken);
        return JsonSerializer.SerializeToNode(result, ScenarioJsonOptions)!;
    }

    private async Task<JsonNode> HandleGetCommunitiesAsync(CancellationToken cancellationToken)
    {
        if (_communities is null)
        {
            return JsonValue.Create("Community context unavailable — call AddAPICover() before AddAPICoverAgent().")!;
        }
        var overview = await _communities.GetOverviewAsync(cancellationToken);
        return JsonSerializer.SerializeToNode(overview, ScenarioJsonOptions)!;
    }

    private async Task<JsonNode> HandleGetCommunityContextAsync(JsonNode? input, CancellationToken cancellationToken)
    {
        if (_communities is null)
        {
            return JsonValue.Create("Community context unavailable — call AddAPICover() before AddAPICoverAgent().")!;
        }
        var index = input?["index"]?.GetValue<int>() ?? -1;
        var context = await _communities.GetCommunityContextAsync(index, cancellationToken);
        if (context is null)
        {
            return JsonValue.Create($"No community with index {index}. Call get_communities first.")!;
        }
        return JsonSerializer.SerializeToNode(context, ScenarioJsonOptions)!;
    }

    private JsonNode HandleListEndpoints(JsonNode? input)
    {
        var area = (input?["area"]?.GetValue<string>())?.Trim();
        var method = (input?["methodFilter"]?.GetValue<string>())?.Trim();

        var endpoints = _discovery.GetEndpoints();
        IEnumerable<EndpointDescriptor> filtered = endpoints;
        if (!string.IsNullOrEmpty(area))
        {
            filtered = filtered.Where(e =>
                e.Area is not null && e.Area.StartsWith(area, StringComparison.OrdinalIgnoreCase));
        }
        if (!string.IsNullOrEmpty(method))
        {
            filtered = filtered.Where(e => string.Equals(e.Method, method, StringComparison.OrdinalIgnoreCase));
        }

        var array = new JsonArray();
        foreach (var e in filtered)
        {
            array.Add(new JsonObject
            {
                ["id"] = e.Id,
                ["method"] = e.Method,
                ["path"] = e.Path,
                ["area"] = e.Area,
                ["purpose"] = e.Purpose,
                ["displayName"] = e.DisplayName,
                ["isDeprecated"] = e.IsDeprecated,
                ["hasRequestBody"] = e.RequestBody is not null,
                ["responseStatusCodes"] = new JsonArray(
                    e.Responses.Select(r => (JsonNode)JsonValue.Create(r.StatusCode)).ToArray())
            });
        }

        return new JsonObject
        {
            ["count"] = array.Count,
            ["endpoints"] = array
        };
    }

    private JsonNode HandleGetEndpointDetails(JsonNode? input)
    {
        var id = input?["id"]?.GetValue<string>();
        if (string.IsNullOrEmpty(id))
        {
            throw new ArgumentException("Required field 'id' is missing.");
        }

        var endpoint = _discovery.GetEndpoints().FirstOrDefault(e => e.Id == id);
        if (endpoint is null)
        {
            return new JsonObject { ["error"] = $"No endpoint found with id '{id}'." };
        }

        return JsonNode.Parse(JsonSerializer.Serialize(endpoint, EndpointJsonOptions))
            ?? new JsonObject();
    }

    private static readonly JsonSerializerOptions EndpointJsonOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull
    };

    private async Task<JsonNode> HandleReadMemoryAsync(JsonNode? input, CancellationToken ct)
    {
        var path = input?["path"]?.GetValue<string>()
            ?? throw new ArgumentException("Required field 'path' is missing.");
        var content = await _memory.ReadAsync(path, ct);
        if (content is null)
        {
            return new JsonObject { ["found"] = false, ["path"] = path };
        }
        return new JsonObject
        {
            ["found"] = true,
            ["path"] = path,
            ["content"] = content
        };
    }

    private async Task<JsonNode> HandleListMemoryAsync(JsonNode? input, CancellationToken ct)
    {
        var prefix = input?["prefix"]?.GetValue<string>();
        var entries = await _memory.ListAsync(prefix, ct);
        var array = new JsonArray();
        foreach (var entry in entries)
        {
            array.Add(new JsonObject
            {
                ["path"] = entry.Path,
                ["bytes"] = entry.Bytes,
                ["updatedAt"] = entry.UpdatedAt.ToString("o")
            });
        }
        return new JsonObject
        {
            ["root"] = _memory.RootPath,
            ["count"] = array.Count,
            ["files"] = array
        };
    }

    private async Task<JsonNode> HandleWriteMemoryAsync(JsonNode? input, CancellationToken ct)
    {
        var path = input?["path"]?.GetValue<string>()
            ?? throw new ArgumentException("Required field 'path' is missing.");
        var content = input?["content"]?.GetValue<string>()
            ?? throw new ArgumentException("Required field 'content' is missing.");
        await _memory.WriteAsync(path, content, ct);
        return new JsonObject { ["ok"] = true, ["path"] = path, ["bytes"] = System.Text.Encoding.UTF8.GetByteCount(content) };
    }

    private async Task<JsonNode> HandleAppendMemoryAsync(JsonNode? input, CancellationToken ct)
    {
        var path = input?["path"]?.GetValue<string>()
            ?? throw new ArgumentException("Required field 'path' is missing.");
        var content = input?["content"]?.GetValue<string>()
            ?? throw new ArgumentException("Required field 'content' is missing.");
        await _memory.AppendAsync(path, content, ct);
        return new JsonObject { ["ok"] = true, ["path"] = path };
    }

    private async Task<JsonNode> HandleDeleteMemoryAsync(JsonNode? input, CancellationToken ct)
    {
        var path = input?["path"]?.GetValue<string>()
            ?? throw new ArgumentException("Required field 'path' is missing.");
        await _memory.DeleteAsync(path, ct);
        return new JsonObject { ["ok"] = true, ["path"] = path };
    }

    private async Task<JsonNode> HandleSaveScenarioAsync(JsonNode? input, CancellationToken ct)
    {
        var payload = input?["scenario"];
        if (payload is null)
        {
            return new JsonObject
            {
                ["ok"] = false,
                ["errors"] = new JsonArray { JsonValue.Create("Required field 'scenario' is missing.") }
            };
        }

        Scenario? parsed;
        try
        {
            parsed = payload.Deserialize<Scenario>(ScenarioJsonOptions);
        }
        catch (JsonException ex)
        {
            return new JsonObject
            {
                ["ok"] = false,
                ["errors"] = new JsonArray { JsonValue.Create($"scenario JSON is malformed: {ex.Message}") }
            };
        }

        if (parsed is null)
        {
            return new JsonObject
            {
                ["ok"] = false,
                ["errors"] = new JsonArray { JsonValue.Create("scenario payload deserialised to null.") }
            };
        }

        var validation = ScenarioValidator.Validate(parsed);
        if (!validation.IsValid)
        {
            var errs = new JsonArray();
            foreach (var e in validation.Errors)
            {
                errs.Add(JsonValue.Create(e));
            }
            return new JsonObject { ["ok"] = false, ["errors"] = errs };
        }

        await _scenarios.SaveAsync(parsed, ct);
        return new JsonObject
        {
            ["ok"] = true,
            ["id"] = parsed.Id,
            ["nodeCount"] = parsed.Nodes.Count,
            ["edgeCount"] = parsed.Edges.Count
        };
    }
}

public sealed record ToolResult(JsonNode Output, bool IsError);
