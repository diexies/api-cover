using System.Text.Json;

namespace APICover.Abstractions.Models;

/// <summary>
/// User-defined HTTP-proxy MCP tool. Persisted to disk so it survives process restarts and
/// surfaces in the inspector's MCP tab as a discrete catalogue entry. Invocation is templated:
/// <c>{{paramName}}</c> placeholders in <see cref="UrlTemplate"/> and <see cref="BodyTemplate"/>
/// are interpolated from the caller's args at runtime.
/// </summary>
public sealed class CustomToolDefinition
{
    /// <summary>Kebab/dotted lowercase identifier matching ^[a-z0-9._-]+$, 3..64 chars.</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>Human-readable purpose. Shown to MCP clients and the in-app agent.</summary>
    public string Description { get; set; } = string.Empty;

    /// <summary>One-liner describing the trigger condition. Renders as a "when" chip in the UI.</summary>
    public string WhenTriggered { get; set; } = string.Empty;

    /// <summary>HTTP method in upper-case: GET, POST, PUT, PATCH, DELETE.</summary>
    public string Method { get; set; } = "GET";

    /// <summary>
    /// Relative path against the host base URL — must start with "/". <c>{{paramName}}</c>
    /// segments are URL-encoded at invocation. Absolute URLs are rejected (SSRF guard).
    /// </summary>
    public string UrlTemplate { get; set; } = string.Empty;

    /// <summary>Static request headers. Authorization is already injected by the named HttpClient.</summary>
    public Dictionary<string, string>? Headers { get; set; }

    /// <summary>
    /// Optional JSON body template. <c>{{paramName}}</c> tokens are replaced with the JSON-encoded
    /// value of the matching arg (so a string param becomes a quoted JSON string, an object becomes
    /// nested JSON). Prevents injection via raw concatenation.
    /// </summary>
    public string? BodyTemplate { get; set; }

    /// <summary>
    /// JSON-Schema-shaped object describing the tool's accepted args:
    /// <c>{ properties: { foo: { type: "string", description: "..." } }, required: ["foo"] }</c>.
    /// </summary>
    public JsonElement ParamsSchema { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    public DateTimeOffset UpdatedAt { get; set; }
}
