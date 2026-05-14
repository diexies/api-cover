using System.Text.Json;
using System.Text.Json.Nodes;
using APICover.Abstractions.Discovery;
using APICover.Abstractions.Models;
using APICover.Abstractions.Services;
using APICover.Abstractions.Validation;
using APICover.Agent.Memory;

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

    private static readonly JsonSerializerOptions ScenarioJsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true
    };

    public ToolDispatcher(IEndpointDiscoveryService discovery, IAgentMemoryStore memory, IScenarioStore scenarios, ICustomToolInvoker? customInvoker = null)
    {
        _discovery = discovery;
        _memory = memory;
        _scenarios = scenarios;
        _customInvoker = customInvoker;
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
