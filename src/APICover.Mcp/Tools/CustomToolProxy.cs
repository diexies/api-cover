using System.ComponentModel;
using System.Text.Json;
using System.Text.Json.Nodes;
using ModelContextProtocol.Server;
using APICover.Agent.Tools;

namespace APICover.Mcp.Tools;

/// <summary>
/// Single MCP tool that proxies invocations to user-defined custom tools. The SDK's
/// reflection-based discovery happens at boot, so newly-created custom tools are not
/// visible as discrete <c>tools/list</c> entries until the process restarts. This proxy
/// lets power users still call them in the meantime via a generic call shape.
/// </summary>
[McpServerToolType]
public static class CustomToolProxy
{
    [McpServerTool(Name = "custom.invoke")]
    [Description("WHEN: an IDE client wants to call a user-defined custom tool before the server has been restarted to publish it as a first-class tool. Pass the tool name and an args object.\n\nInvoke a user-defined custom tool. Returns { ok, status, body } on HTTP success, { ok:false, error } otherwise.")]
    public static async Task<object> Invoke(
        ICustomToolInvoker invoker,
        [Description("Name of the custom tool to invoke (see /apicover/api/mcp/info for the catalogue).")] string toolName,
        [Description("Argument object matching the tool's paramsSchema.")] JsonElement args,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(toolName))
        {
            return new { ok = false, error = "toolName is required." };
        }

        JsonNode? argsNode = args.ValueKind switch
        {
            JsonValueKind.Object => JsonNode.Parse(args.GetRawText()),
            JsonValueKind.Null or JsonValueKind.Undefined => new JsonObject(),
            _ => null,
        };
        if (argsNode is null)
        {
            return new { ok = false, error = $"args must be a JSON object, got {args.ValueKind}." };
        }

        var result = await invoker.TryInvokeAsync(toolName, argsNode, ct);
        if (result is null)
        {
            return new { ok = false, error = $"unknown custom tool '{toolName}'." };
        }
        return result;
    }
}
