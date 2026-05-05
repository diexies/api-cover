using System.Text.Json.Nodes;

namespace APICover.Abstractions.Models;

/// <summary>
/// A single API call within a scenario. Request fields are stored as JSON values that may
/// embed JSONLogic operator sub-trees (e.g. <c>{ "var": "nodes.create.response.body.id" }</c>).
/// They are resolved at execution time against the run's <see cref="ExecutionContext"/>.
/// </summary>
public sealed class ApiNode
{
    /// <summary>Stable id within the scenario (used as key in execution context).</summary>
    public required string Id { get; init; }

    /// <summary>Human-friendly label shown in the UI.</summary>
    public string? Label { get; init; }

    /// <summary>HTTP method (GET, POST, …).</summary>
    public required string Method { get; init; }

    /// <summary>
    /// Path template targeting the host application (e.g. <c>/users/{id}</c>). Path parameters
    /// are filled from <see cref="PathParameters"/>; query parameters from <see cref="QueryParameters"/>.
    /// </summary>
    public required string Path { get; init; }

    /// <summary>Path parameter rules (each value may be a JSONLogic rule).</summary>
    public IDictionary<string, JsonNode?> PathParameters { get; init; } = new Dictionary<string, JsonNode?>();

    /// <summary>Query parameter rules (each value may be a JSONLogic rule).</summary>
    public IDictionary<string, JsonNode?> QueryParameters { get; init; } = new Dictionary<string, JsonNode?>();

    /// <summary>Header rules (each value may be a JSONLogic rule).</summary>
    public IDictionary<string, JsonNode?> Headers { get; init; } = new Dictionary<string, JsonNode?>();

    /// <summary>
    /// Optional request body. Pure literal JSON is sent as-is; any JSONLogic operator sub-trees
    /// are evaluated against the execution context first.
    /// </summary>
    public JsonNode? Body { get; init; }

    /// <summary>Optional content-type override (defaults to application/json when body is present).</summary>
    public string? ContentType { get; init; }

    /// <summary>
    /// When set, the engine reads the response as a stream (SSE / NDJSON / chunked JSON) instead
    /// of buffering the whole body. The mode controls when to stop and what to forward as
    /// <c>nodes.{id}.response.body</c> to downstream nodes.
    /// </summary>
    public StreamingNodeOptions? Streaming { get; init; }

    /// <summary>UI hint: position on the DAG canvas. Ignored by the engine.</summary>
    public NodePosition? Position { get; init; }

    /// <summary>
    /// Optional JSONLogic predicate evaluated before this node runs. When the rule resolves
    /// to a falsy value, the engine marks the node Skipped (and propagates skip to descendants).
    /// Context: the full <c>ExecutionContext</c> (<c>nodes.*</c>, <c>vars.*</c>, etc.).
    /// </summary>
    public JsonNode? ShouldRun { get; init; }
}

/// <summary>UI-only positioning data.</summary>
public readonly record struct NodePosition(double X, double Y);

/// <summary>How a streaming response should be consumed.</summary>
public sealed class StreamingNodeOptions
{
    /// <summary>Termination strategy. See <see cref="StreamingMode"/>.</summary>
    public StreamingMode Mode { get; init; } = StreamingMode.Collect;

    /// <summary>How to parse incoming bytes into discrete messages.</summary>
    public StreamParser Parser { get; init; } = StreamParser.Auto;

    /// <summary>JSONLogic predicate evaluated against each message; the run advances when this
    /// becomes truthy (only for <see cref="StreamingMode.Until"/>).
    /// Context: <c>{ "message": ..., "index": N, "elapsed": "PT..." }</c>.</summary>
    public JsonNode? Until { get; init; }

    /// <summary>Optional ceiling on stream duration. Reached → stream is closed.</summary>
    public TimeSpan? Timeout { get; init; }

    /// <summary>Optional ceiling on number of messages. Reached → stream is closed.</summary>
    public int? MaxMessages { get; init; }
}

public enum StreamingMode
{
    /// <summary>Read every message until EOF / timeout / maxMessages; expose as an array.</summary>
    Collect = 0,
    /// <summary>Stop at the first message; expose that single message.</summary>
    First = 1,
    /// <summary>Stop at the first message satisfying <see cref="StreamingNodeOptions.Until"/>.</summary>
    Until = 2
}

public enum StreamParser
{
    /// <summary>Pick by Content-Type: <c>text/event-stream</c> → SSE, <c>application/x-ndjson</c> → NDJSON, otherwise raw chunks.</summary>
    Auto = 0,
    /// <summary>Server-Sent Events (<c>data:</c> framing).</summary>
    Sse = 1,
    /// <summary>Newline-delimited JSON (one JSON value per line).</summary>
    Ndjson = 2,
    /// <summary>Raw byte chunks decoded as UTF-8 strings.</summary>
    Raw = 3
}
