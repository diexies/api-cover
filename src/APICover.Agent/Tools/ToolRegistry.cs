using System.Text.Json.Nodes;
using APICover.Abstractions.Services;
using APICover.Agent.Anthropic;

namespace APICover.Agent.Tools;

/// <summary>
/// The static set of tools exposed to Claude in M1. Names match what the dispatcher
/// switches on. Schemas are JSON Schema (draft 2020-12 subset Anthropic accepts).
/// </summary>
public static class ToolRegistry
{
    public const string ListEndpoints = "list_endpoints";
    public const string GetEndpointDetails = "get_endpoint_details";
    public const string ReadMemory = "read_memory";
    public const string ListMemory = "list_memory";
    public const string WriteMemory = "write_memory";
    public const string AppendMemory = "append_memory";
    public const string DeleteMemory = "delete_memory";
    public const string SaveScenario = "save_scenario";

    public static IReadOnlyList<ToolDefinition> Definitions { get; } = BuildDefinitions();

    /// <summary>
    /// Returns the static built-in definitions plus any user-defined custom tools currently
    /// in the store. Called by the run coordinator when assembling the tool list sent to
    /// Claude so the agent can invoke custom tools directly (no restart needed for in-app use).
    /// </summary>
    public static async Task<IReadOnlyList<ToolDefinition>> BuildClaudeToolListAsync(ICustomToolStore? store, CancellationToken ct = default)
    {
        if (store is null) return Definitions;
        var customs = await store.ListAsync(ct);
        if (customs.Count == 0) return Definitions;
        var list = new List<ToolDefinition>(Definitions);
        foreach (var def in customs)
        {
            var schemaText = def.ParamsSchema.GetRawText();
            list.Add(new ToolDefinition
            {
                Name = def.Name,
                Description = string.IsNullOrWhiteSpace(def.WhenTriggered)
                    ? def.Description
                    : $"WHEN: {def.WhenTriggered}\n\n{def.Description}",
                InputSchema = JsonNode.Parse(schemaText) ?? new JsonObject { ["type"] = "object" },
            });
        }
        return list;
    }

    private static IReadOnlyList<ToolDefinition> BuildDefinitions()
    {
        return new[]
        {
            new ToolDefinition
            {
                Name = ListEndpoints,
                Description =
                    "List the HTTP endpoints exposed by this ASP.NET Core application. "
                  + "Returns a slim summary per endpoint (id, method, path, area, purpose). "
                  + "Call this first when asked about the API. Use get_endpoint_details for "
                  + "the full descriptor of any single endpoint.",
                InputSchema = JsonNode.Parse("""
                {
                  "type": "object",
                  "properties": {
                    "area": {
                      "type": "string",
                      "description": "Optional area filter (case-insensitive prefix match against EndpointDescriptor.Area)."
                    },
                    "methodFilter": {
                      "type": "string",
                      "description": "Optional HTTP method filter (e.g. 'GET'). Case-insensitive.",
                      "enum": ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]
                    }
                  }
                }
                """)!
            },
            new ToolDefinition
            {
                Name = GetEndpointDetails,
                Description =
                    "Fetch the full EndpointDescriptor for a single endpoint, including "
                  + "parameters with JSON schemas, request body schema, response schemas, "
                  + "auth requirements, and sample payloads. Required input: the endpoint id "
                  + "as returned by list_endpoints (e.g. 'POST /users').",
                InputSchema = JsonNode.Parse("""
                {
                  "type": "object",
                  "required": ["id"],
                  "properties": {
                    "id": {
                      "type": "string",
                      "description": "Endpoint identifier (METHOD /path) from list_endpoints."
                    }
                  }
                }
                """)!
            },
            new ToolDefinition
            {
                Name = ReadMemory,
                Description =
                    "Read a memory file by relative path (e.g. 'controllers/payment.md'). "
                  + "Returns the markdown content or an error if missing. Use this BEFORE "
                  + "answering any question — memory holds prior agent runs' findings.",
                InputSchema = JsonNode.Parse("""
                {
                  "type": "object",
                  "required": ["path"],
                  "properties": {
                    "path": { "type": "string", "description": "Relative path under memory root, must end in .md" }
                  }
                }
                """)!
            },
            new ToolDefinition
            {
                Name = ListMemory,
                Description =
                    "List memory files. Use this first to see what memory exists. Optional "
                  + "prefix narrows to a sub-tree (e.g. 'services/'). Returns paths + sizes.",
                InputSchema = JsonNode.Parse("""
                {
                  "type": "object",
                  "properties": {
                    "prefix": { "type": "string", "description": "Optional path prefix filter, e.g. 'services/'." }
                  }
                }
                """)!
            },
            new ToolDefinition
            {
                Name = WriteMemory,
                Description =
                    "Create or replace a memory file. Use for fresh artifacts (a new "
                  + "controller summary) or when wholesale-rewriting an outdated file. "
                  + "Prefer append_memory for incremental additions to keep human edits "
                  + "intact. Path must end in .md and live under root.",
                InputSchema = JsonNode.Parse("""
                {
                  "type": "object",
                  "required": ["path", "content"],
                  "properties": {
                    "path": { "type": "string" },
                    "content": { "type": "string", "description": "Full markdown body. Replaces any existing file at this path." }
                  }
                }
                """)!
            },
            new ToolDefinition
            {
                Name = AppendMemory,
                Description =
                    "Append to an existing memory file. Creates the file with the supplied "
                  + "content if it doesn't exist. Use to add a learned-during-run section "
                  + "without overwriting prior content or human edits.",
                InputSchema = JsonNode.Parse("""
                {
                  "type": "object",
                  "required": ["path", "content"],
                  "properties": {
                    "path": { "type": "string" },
                    "content": { "type": "string", "description": "Markdown to append. Include a leading newline if the file already has content." }
                  }
                }
                """)!
            },
            new ToolDefinition
            {
                Name = DeleteMemory,
                Description =
                    "Delete a memory file. Use ONLY when the file describes something that "
                  + "no longer exists in the project (e.g. a controller has been removed). "
                  + "When in doubt, leave it alone — humans can clean up.",
                InputSchema = JsonNode.Parse("""
                {
                  "type": "object",
                  "required": ["path"],
                  "properties": {
                    "path": { "type": "string" }
                  }
                }
                """)!
            },
            new ToolDefinition
            {
                Name = SaveScenario,
                Description =
                    "Persist a complete Scenario JSON document so the user can run it. "
                  + "Use this only in scenario-generation mode after you have called "
                  + "list_endpoints and get_endpoint_details and have a complete DAG. "
                  + "Returns {ok:true,id,nodeCount,edgeCount} on success, or "
                  + "{ok:false,errors:[...]} when validation fails — read the errors, "
                  + "fix the JSON, and call again (max 3 retries). "
                  + "Required shape: { id (^[a-z0-9-]+$), name, nodes:[{id,method,path,body?,"
                  + "pathParameters?,queryParameters?,headers?}], edges:[{from,to,condition?}], "
                  + "description?, tags?, startNodeIds?, caseSets?, groups?, breakpoints? }. "
                  + "Example: {\"id\":\"login-flow\",\"name\":\"Login flow\","
                  + "\"nodes\":[{\"id\":\"login\",\"method\":\"POST\",\"path\":\"/api/auth/login\","
                  + "\"body\":{\"user\":\"a\",\"pass\":\"b\"}},"
                  + "{\"id\":\"profile\",\"method\":\"GET\",\"path\":\"/api/me\"}],"
                  + "\"edges\":[{\"from\":\"login\",\"to\":\"profile\"}],"
                  + "\"startNodeIds\":[\"login\"]}",
                InputSchema = JsonNode.Parse("""
                {
                  "type": "object",
                  "required": ["scenario"],
                  "properties": {
                    "scenario": {
                      "type": "object",
                      "description": "Full Scenario JSON document. See tool description for shape and example."
                    }
                  }
                }
                """)!
            }
        };
    }
}
