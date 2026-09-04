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
