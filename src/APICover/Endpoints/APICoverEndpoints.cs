using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using APICover.Abstractions.Discovery;
using APICover.Abstractions.Models;
using APICover.Abstractions.Services;
using APICover.Discovery;
using APICover.Engine;

namespace APICover.Endpoints;

/// <summary>
/// HTTP endpoints exposed by the inspector under the configured path prefix
/// (default <c>/inspector</c>). Pure JSON; the SPA is mounted separately.
/// </summary>
internal static class APICoverEndpoints
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) }
    };

    public static void MapAll(IEndpointRouteBuilder endpoints, string prefix)
    {
        var api = endpoints.MapGroup($"{prefix}/api");
        // Hide inspector's own endpoints from its own discovery output (and Swagger).
        api.WithMetadata(new ExploreIgnoreAttribute()).ExcludeFromDescription();

        api.MapGet("/discovery", (IEndpointDiscoveryService disc)
            => Results.Json(disc.GetEndpoints(), Json));

        // Surfaces UI-relevant feature toggles so the SPA can render conditionally.
        api.MapGet("/options", (IOptions<APICoverOptions> o)
            => Results.Json(new { enableCallGraph = o.Value.EnableCallGraphInspection }, Json));

        // Call-graph inspection — gated by EnableCallGraphInspection. Endpoint ids contain
        // forward slashes (e.g. "POST /invoices"), and ASP.NET Core's catch-all routing
        // doesn't decode `%2F` in path segments. Pass the id as a query parameter instead.
        var cg = api.MapGroup("/call-graphs");
        cg.MapGet("/", async (string id, ICallGraphService svc, IOptions<APICoverOptions> o) =>
        {
            if (!o.Value.EnableCallGraphInspection) return Results.NotFound();
            var g = await svc.GetForEndpointAsync(id);
            return g is null ? Results.NotFound() : Results.Json(g, Json);
        });
        cg.MapPost("/rebuild", async (ICallGraphService svc, IOptions<APICoverOptions> o) =>
        {
            if (!o.Value.EnableCallGraphInspection) return Results.NotFound();
            var rebuilt = await svc.RebuildAllAsync();
            return Results.Json(new { rebuilt = rebuilt.Count }, Json);
        });

        // Service catalog — cross-endpoint aggregation. Same gate as call-graphs since the
        // data source IS the call graphs.
        api.MapGet("/services", async (IServiceCatalogService svc, IOptions<APICoverOptions> o) =>
        {
            if (!o.Value.EnableCallGraphInspection) return Results.NotFound();
            var catalog = await svc.BuildAsync();
            return Results.Json(catalog, Json);
        });

        api.MapGet("/discovery/grouped", (IEndpointDiscoveryService disc)
            => Results.Json(DiscoveryGrouping.Group(disc.GetEndpoints()), Json));

        api.MapGet("/scenarios", async (IScenarioStore store)
            => Results.Json(await store.ListAsync(), Json));

        api.MapGet("/scenarios/{id}", async (string id, IScenarioStore store) =>
        {
            var s = await store.GetAsync(id);
            return s is null ? Results.NotFound() : Results.Json(s, Json);
        });

        api.MapPut("/scenarios/{id}", async (string id, HttpRequest request, IScenarioStore store) =>
        {
            var scenario = await JsonSerializer.DeserializeAsync<Scenario>(request.Body, Json);
            if (scenario is null || scenario.Id != id) return Results.BadRequest();
            await store.SaveAsync(scenario);
            return Results.Json(scenario, Json);
        });

        api.MapDelete("/scenarios/{id}", async (string id, IScenarioStore store) =>
        {
            await store.DeleteAsync(id);
            return Results.NoContent();
        });

        api.MapPost("/scenarios/{id}/runs", async (string id, HttpRequest request, IScenarioStore store, IScenarioEngine engine) =>
        {
            var scenario = await store.GetAsync(id);
            if (scenario is null) return Results.NotFound();

            var options = new RunOptions();
            if (request.ContentLength is > 0)
            {
                using var doc = await JsonDocument.ParseAsync(request.Body);
                if (doc.RootElement.ValueKind == JsonValueKind.Object)
                {
                    var rawInput = doc.RootElement.TryGetProperty("input", out var inputEl) ? inputEl.GetRawText() : null;
                    var input = rawInput is null ? null : JsonNode.Parse(rawInput) as JsonObject;
                    var bp = doc.RootElement.TryGetProperty("breakpointsEnabled", out var bpEl) && bpEl.ValueKind == JsonValueKind.False
                        ? false : true;
                    var headers = ReadStringMap(doc.RootElement, "headers");
                    var query = ReadStringMap(doc.RootElement, "queryParameters");
                    options = new RunOptions
                    {
                        Input = input,
                        BreakpointsEnabled = bp,
                        Headers = headers,
                        QueryParameters = query
                    };
                }
            }

            var run = await engine.StartAsync(scenario, options);
            return Results.Json(run, Json);
        });

        static IReadOnlyDictionary<string, string>? ReadStringMap(JsonElement root, string property)
        {
            if (!root.TryGetProperty(property, out var el) || el.ValueKind != JsonValueKind.Object) return null;
            var dict = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var p in el.EnumerateObject())
            {
                if (p.Value.ValueKind == JsonValueKind.String)
                {
                    dict[p.Name] = p.Value.GetString() ?? string.Empty;
                }
                else if (p.Value.ValueKind != JsonValueKind.Null)
                {
                    dict[p.Name] = p.Value.GetRawText();
                }
            }
            return dict.Count == 0 ? null : dict;
        }

        api.MapGet("/runs", async (string? scenarioId, IRunStore store)
            => Results.Json(await store.ListAsync(scenarioId), Json));

        api.MapGet("/runs/{id}", async (string id, IRunStore store) =>
        {
            var r = await store.GetAsync(id);
            return r is null ? Results.NotFound() : Results.Json(r, Json);
        });

        api.MapGet("/runs/{id}/events", RunEventStreamHandler);

        static async Task RunEventStreamHandler(string id, HttpContext ctx, IRunEventBus bus, IRunStore store)
        {
            var run = await store.GetAsync(id);
            if (run is null)
            {
                ctx.Response.StatusCode = StatusCodes.Status404NotFound;
                return;
            }

            ctx.Response.Headers.ContentType = "text/event-stream";
            ctx.Response.Headers.CacheControl = "no-cache";
            ctx.Response.Headers["X-Accel-Buffering"] = "no";

            // Replay current state once so a late subscriber sees where the run is.
            await WriteEvent(ctx, "snapshot", JsonSerializer.Serialize(run, Json));
            if (run.Status is RunStatus.Succeeded or RunStatus.Failed or RunStatus.Cancelled)
            {
                await WriteEvent(ctx, "runFinished", JsonSerializer.Serialize(run, Json));
                return;
            }

            try
            {
                await foreach (var evt in bus.SubscribeAsync(id, ctx.RequestAborted))
                {
                    var name = evt.Type switch
                    {
                        RunEventType.RunStarted => "runStarted",
                        RunEventType.RunStatusChanged => "runStatusChanged",
                        RunEventType.NodeStarted => "nodeStarted",
                        RunEventType.NodeCompleted => "nodeCompleted",
                        RunEventType.NodePaused => "nodePaused",
                        RunEventType.NodeResumed => "nodeResumed",
                        RunEventType.RunFinished => "runFinished",
                        _ => "event"
                    };
                    var payload = JsonSerializer.Serialize(evt, Json);
                    await WriteEvent(ctx, name, payload);
                    if (evt.Type == RunEventType.RunFinished) break;
                }
            }
            catch (OperationCanceledException)
            {
                // Client disconnected.
            }
        }

        static async Task WriteEvent(HttpContext ctx, string name, string data)
        {
            await ctx.Response.WriteAsync($"event: {name}\n");
            // SSE spec: split on newlines, prefix each with "data: ".
            foreach (var line in data.Split('\n'))
            {
                await ctx.Response.WriteAsync($"data: {line}\n");
            }
            await ctx.Response.WriteAsync("\n");
            await ctx.Response.Body.FlushAsync();
        }

        // Quick Call — single-shot HTTP send for the playground UI. Bypasses scenario/run
        // machinery; takes literal request fields, applies path/query/header substitutions,
        // sends through the engine's HttpClient (so base address + auth handlers apply),
        // returns the captured ResponseSnapshot.
        api.MapPost("/quick-call", async (HttpRequest request, HttpContext httpCtx, IHttpClientFactory httpFactory) =>
        {
            using var doc = await JsonDocument.ParseAsync(request.Body);
            var root = doc.RootElement;
            var method = (root.TryGetProperty("method", out var mEl) && mEl.ValueKind == JsonValueKind.String)
                ? mEl.GetString()! : "GET";
            var path = (root.TryGetProperty("path", out var pEl) && pEl.ValueKind == JsonValueKind.String)
                ? pEl.GetString()! : "/";
            var pathParams = ReadStringMap(root, "pathParameters");
            var queryParams = ReadStringMap(root, "queryParameters");
            var headerMap = ReadStringMap(root, "headers");
            var contentType = (root.TryGetProperty("contentType", out var ctEl) && ctEl.ValueKind == JsonValueKind.String)
                ? ctEl.GetString() : null;
            JsonNode? body = null;
            if (root.TryGetProperty("body", out var bEl) && bEl.ValueKind != JsonValueKind.Null)
            {
                body = JsonNode.Parse(bEl.GetRawText());
            }

            // Path-template substitution: /users/{id} + {id: "5"} → /users/5.
            if (pathParams is { Count: > 0 })
            {
                foreach (var (k, v) in pathParams)
                {
                    path = path.Replace("{" + k + "}", Uri.EscapeDataString(v ?? string.Empty), StringComparison.Ordinal);
                }
            }

            // Query string from collected params.
            if (queryParams is { Count: > 0 })
            {
                var pairs = queryParams
                    .Where(kv => !string.IsNullOrEmpty(kv.Key))
                    .Select(kv => $"{Uri.EscapeDataString(kv.Key)}={Uri.EscapeDataString(kv.Value ?? string.Empty)}");
                var qs = string.Join("&", pairs);
                if (qs.Length > 0)
                {
                    path = path.Contains('?', StringComparison.Ordinal) ? $"{path}&{qs}" : $"{path}?{qs}";
                }
            }

            using var msg = new HttpRequestMessage(new HttpMethod(method.ToUpperInvariant()), path);
            if (headerMap is { Count: > 0 })
            {
                foreach (var (k, v) in headerMap)
                {
                    msg.Headers.TryAddWithoutValidation(k, v);
                }
            }
            if (body is not null)
            {
                msg.Content = new StringContent(body.ToJsonString(), Encoding.UTF8);
                if (!string.IsNullOrEmpty(contentType))
                {
                    msg.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(contentType);
                }
                else
                {
                    msg.Content.Headers.ContentType = MediaTypeHeaderValue.Parse("application/json");
                }
            }

            var client = httpFactory.CreateClient(ScenarioEngine.HttpClientNamePublic);
            var startedAt = DateTimeOffset.UtcNow;
            try
            {
                using var resp = await client.SendAsync(msg, httpCtx.RequestAborted);
                var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                foreach (var h in resp.Headers) headers[h.Key] = string.Join(",", h.Value);
                if (resp.Content is not null)
                {
                    foreach (var h in resp.Content.Headers) headers[h.Key] = string.Join(",", h.Value);
                }
                var respCt = resp.Content?.Headers.ContentType?.MediaType;
                var bodyText = resp.Content is null ? null : await resp.Content.ReadAsStringAsync();
                JsonNode? respBody = null;
                if (!string.IsNullOrEmpty(bodyText))
                {
                    try { respBody = JsonNode.Parse(bodyText); }
                    catch (JsonException) { respBody = JsonValue.Create(bodyText); }
                }
                var snapshot = new
                {
                    request = new { method, path, headers = headerMap, body, contentType },
                    response = new { status = (int)resp.StatusCode, headers, body = respBody, contentType = respCt },
                    elapsedMs = (DateTimeOffset.UtcNow - startedAt).TotalMilliseconds,
                };
                return Results.Json(snapshot, Json);
            }
            catch (Exception ex)
            {
                return Results.Json(new
                {
                    error = ex.Message,
                    elapsedMs = (DateTimeOffset.UtcNow - startedAt).TotalMilliseconds,
                }, Json, statusCode: 502);
            }
        });

        api.MapPost("/runs/{id}/breakpoints/{nodeId}/resolve",
            async (string id, string nodeId, HttpRequest request, IBreakpointController bp) =>
        {
            var decision = await JsonSerializer.DeserializeAsync<BreakpointDecision>(request.Body, Json);
            if (decision is null) return Results.BadRequest();
            try
            {
                await bp.ResolveAsync(id, nodeId, decision);
                return Results.NoContent();
            }
            catch (InvalidOperationException ex)
            {
                return Results.Problem(ex.Message, statusCode: 409);
            }
        });
    }
}
