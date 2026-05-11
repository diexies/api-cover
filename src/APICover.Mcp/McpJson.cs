using System.Text.Json;
using System.Text.Json.Serialization;

namespace APICover.Mcp;

/// <summary>
/// Single source of truth for JSON serialisation in tool outputs. Mirrors the inspector's
/// HTTP API conventions (<c>JsonSerializerDefaults.Web</c>, camelCase enums, ignore null)
/// so an LLM that has seen the HTTP responses sees identically shaped MCP responses.
/// </summary>
internal static class McpJson
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };
}
