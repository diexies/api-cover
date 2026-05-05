using System.Text.Json.Nodes;

namespace APICover.Abstractions.Discovery;

/// <summary>
/// A single endpoint exposed by the host ASP.NET Core application, surfaced to the inspector
/// UI as a draggable building block. Mirrors what Swagger / Swashbuckle exposes but enriched
/// with Utopia-specific metadata (area, purpose, samples) and ready-to-render JSON Schemas
/// for request and response bodies.
/// </summary>
public sealed class EndpointDescriptor
{
    /// <summary>Stable identifier (typically <c>METHOD /path</c>).</summary>
    public required string Id { get; init; }

    /// <summary>HTTP method (GET, POST, …).</summary>
    public required string Method { get; init; }

    /// <summary>Route template (e.g. <c>/users/{id}</c>).</summary>
    public required string Path { get; init; }

    /// <summary>Optional human-readable display name.</summary>
    public string? DisplayName { get; init; }

    /// <summary>OpenAPI / ApiExplorer group name (kept for backwards compat).</summary>
    public string? GroupName { get; init; }

    /// <summary>Logical area resolved from <see cref="ExploreAreaAttribute"/>, <see cref="ExploreEndpointAttribute"/>,
    /// or controller-name convention. Drives UI grouping. <c>null</c> = uncategorized.</summary>
    public string? Area { get; init; }

    /// <summary>Free-form intent label (e.g. <c>"user-action"</c>, <c>"background-job"</c>, <c>"internal"</c>).</summary>
    public string? Purpose { get; init; }

    /// <summary>Long-form description from XML doc, <c>[Description]</c>, or endpoint summary metadata.</summary>
    public string? Description { get; init; }

    /// <summary>Free-form tag chips (e.g. from <c>[Tags]</c> or <c>WithTags(...)</c>).</summary>
    public IReadOnlyList<string> Tags { get; init; } = Array.Empty<string>();

    /// <summary>True when the endpoint is marked obsolete or otherwise deprecated.</summary>
    public bool IsDeprecated { get; init; }

    /// <summary>How the endpoint was registered (controller vs minimal API).</summary>
    public EndpointSourceKind Source { get; init; }

    /// <summary>Type or delegate name of the handler, when discoverable.</summary>
    public string? HandlerTypeName { get; init; }

    /// <summary>Path / query / header / cookie / form parameters declared on the route.</summary>
    public IReadOnlyList<EndpointParameter> Parameters { get; init; } = Array.Empty<EndpointParameter>();

    /// <summary>Request body description, including content type and JSON Schema.</summary>
    public EndpointRequestBody? RequestBody { get; init; }

    /// <summary>Declared responses keyed by HTTP status code.</summary>
    public IReadOnlyList<EndpointResponse> Responses { get; init; } = Array.Empty<EndpointResponse>();

    /// <summary>Authorization requirements declared on the endpoint.</summary>
    public EndpointAuthRequirement? Authorization { get; init; }

    /// <summary>Sample payloads contributed via <see cref="ExploreSampleAttribute"/>.</summary>
    public IReadOnlyList<EndpointSample> Samples { get; init; } = Array.Empty<EndpointSample>();

    /// <summary>Convenience: true when <see cref="RequestBody"/> is non-null. Kept for backwards compat.</summary>
    public bool HasBody => RequestBody is not null;
}

public sealed class EndpointParameter
{
    public required string Name { get; init; }
    public required ParameterLocation In { get; init; }

    /// <summary>Short CLR type name (e.g. <c>"Int32"</c>). Kept for backwards compat; prefer <see cref="Schema"/>.</summary>
    public string? Type { get; init; }

    public string? Description { get; init; }
    public bool Required { get; init; }
    public bool IsDeprecated { get; init; }

    /// <summary>Default value, when declared.</summary>
    public JsonNode? DefaultValue { get; init; }

    /// <summary>JSON Schema (subset) for this parameter's value.</summary>
    public JsonNode? Schema { get; init; }

    /// <summary>Allowed enum values, when applicable.</summary>
    public IReadOnlyList<string> EnumValues { get; init; } = Array.Empty<string>();

    /// <summary>Validation hints (e.g. <c>"minLength" → "3"</c>, <c>"pattern" → "..."</c>).</summary>
    public IReadOnlyDictionary<string, string?> Validations { get; init; }
        = new Dictionary<string, string?>();
}

public sealed class EndpointRequestBody
{
    /// <summary>Supported request media types.</summary>
    public IReadOnlyList<EndpointMediaType> Content { get; init; } = Array.Empty<EndpointMediaType>();

    /// <summary>True when a body is required.</summary>
    public bool Required { get; init; }
}

public sealed class EndpointResponse
{
    /// <summary>HTTP status code; <c>0</c> represents the OpenAPI <c>"default"</c> bucket.</summary>
    public required int StatusCode { get; init; }

    public string? Description { get; init; }

    /// <summary>Supported response media types.</summary>
    public IReadOnlyList<EndpointMediaType> Content { get; init; } = Array.Empty<EndpointMediaType>();

    /// <summary>
    /// Coarse classification of the response payload (single JSON object, SSE stream, NDJSON,
    /// binary blob, …). Drives the inspector UI's "is this streaming?" UX so the user can pick
    /// a streaming node mode (<c>collect</c> / <c>until</c> / <c>first</c>) when appropriate.
    /// </summary>
    public ResponseKind Kind { get; init; } = ResponseKind.Unknown;
}

public sealed class EndpointMediaType
{
    public required string ContentType { get; init; }
    public JsonNode? Schema { get; init; }
    public JsonNode? Example { get; init; }

    /// <summary>Kind derived from this specific media type (informational; the response-level
    /// <see cref="EndpointResponse.Kind"/> is the canonical answer).</summary>
    public ResponseKind Kind { get; init; } = ResponseKind.Unknown;
}

/// <summary>How a response payload should be consumed by the engine and rendered by the UI.</summary>
public enum ResponseKind
{
    /// <summary>Couldn't determine — fall back to "read whole body".</summary>
    Unknown = 0,
    /// <summary>Single JSON document.</summary>
    Json = 1,
    /// <summary>Plain text / HTML / similar single-value payload.</summary>
    Text = 2,
    /// <summary>Binary blob (octet-stream, image, pdf, …).</summary>
    Binary = 3,
    /// <summary>Server-Sent Events stream (<c>text/event-stream</c>).</summary>
    Sse = 4,
    /// <summary>Newline-delimited JSON (one JSON value per line).</summary>
    Ndjson = 5,
    /// <summary>Generic chunked stream (CLR <c>Stream</c> / <c>FileStreamResult</c> / …).</summary>
    Stream = 6
}

public sealed class EndpointAuthRequirement
{
    public bool RequiresAuthentication { get; init; }
    public IReadOnlyList<string> Policies { get; init; } = Array.Empty<string>();
    public IReadOnlyList<string> Roles { get; init; } = Array.Empty<string>();
    public IReadOnlyList<string> AuthenticationSchemes { get; init; } = Array.Empty<string>();
    public bool AllowsAnonymous { get; init; }
}

public sealed class EndpointSample
{
    public required string Name { get; init; }
    public required string JsonPayload { get; init; }
    public string? Description { get; init; }
}

public enum EndpointSourceKind
{
    Unknown = 0,
    Controller = 1,
    MinimalApi = 2
}

public enum ParameterLocation
{
    Path = 0,
    Query = 1,
    Header = 2,
    Cookie = 3,
    Form = 4
}

/// <summary>Provides the list of endpoints exposed by the host application.</summary>
public interface IEndpointDiscoveryService
{
    IReadOnlyList<EndpointDescriptor> GetEndpoints();
}
