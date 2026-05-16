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
using APICover.Storage;

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

        // Source file slice. UI right-click → "View source" → drawer with file contents
        // around the given line. Locked under the host environment's ContentRootPath to
        // block path traversal. Only used when the user has explicitly clicked a node
        // that already exposes a filePath from PDB-resolved IL walks.
        api.MapGet("/source", (string path, int? line, int? endLine, int? context, Microsoft.Extensions.Hosting.IHostEnvironment env) =>
        {
            if (string.IsNullOrWhiteSpace(path)) return Results.BadRequest(new { error = "path required" });
            string full;
            try { full = System.IO.Path.GetFullPath(path); }
            catch { return Results.BadRequest(new { error = "invalid path" }); }
            if (!System.IO.File.Exists(full)) return Results.NotFound();
            var ext = System.IO.Path.GetExtension(full).ToLowerInvariant();
            if (ext != ".cs" && ext != ".razor" && ext != ".cshtml") return Results.BadRequest(new { error = "unsupported extension" });
            string[] lines;
            try { lines = System.IO.File.ReadAllLines(full); }
            catch (Exception ex) { return Results.Problem(ex.Message); }
            var total = lines.Length;
            int from = 0, to = total;
            if (line is > 0)
            {
                var ctx = context ?? 40;
                var lo = line.Value - 1 - ctx;
                // When the caller knows the method's end line we widen the window down to it
                // (plus a small tail) so the whole method body is visible without paging.
                var hiSource = endLine is > 0 ? endLine.Value - 1 + ctx : line.Value - 1 + ctx;
                from = Math.Max(0, lo);
                to = Math.Min(total, hiSource);
                if (to < from) to = from;
            }
            var slice = new string[to - from];
            Array.Copy(lines, from, slice, 0, slice.Length);
            return Results.Json(new
            {
                path = full,
                language = ext.TrimStart('.'),
                totalLines = total,
                startLine = from + 1,
                endLine = to,
                methodStart = line,
                methodEnd = endLine,
                lines = slice
            }, Json);
        }).WithMetadata(new ExploreIgnoreAttribute()).ExcludeFromDescription();

        // Method-level control-flow flowchart. Reuses the same path validation as /source
        // (allowed extensions, file existence), then hands the source text to the Roslyn-backed
        // builder. Returns { methodName, language, nodes[], edges[], truncated, error? } so the
        // UI can pass it straight to xyflow without further parsing.
        api.MapGet("/source/flowchart", (string path, int line) =>
        {
            if (string.IsNullOrWhiteSpace(path)) return Results.BadRequest(new { error = "path required" });
            if (line < 1) return Results.BadRequest(new { error = "line must be >= 1" });
            string full;
            try { full = System.IO.Path.GetFullPath(path); }
            catch { return Results.BadRequest(new { error = "invalid path" }); }
            if (!System.IO.File.Exists(full)) return Results.NotFound();
            var ext = System.IO.Path.GetExtension(full).ToLowerInvariant();
            if (ext != ".cs") return Results.BadRequest(new { error = "flowchart only supported for .cs files" });
            string sourceText;
            try { sourceText = System.IO.File.ReadAllText(full); }
            catch (Exception ex) { return Results.Problem(ex.Message); }
            var result = APICover.Discovery.Flowchart.MethodFlowchartBuilder.Build(sourceText, line);
            return Results.Json(result, Json);
        }).WithMetadata(new ExploreIgnoreAttribute()).ExcludeFromDescription();

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
        cg.MapPost("/rebuild", async (ICallGraphService svc, IReverseCallIndexService reverse, IOptions<APICoverOptions> o) =>
        {
            if (!o.Value.EnableCallGraphInspection) return Results.NotFound();
            var rebuilt = await svc.RebuildAllAsync();
            // Rebuild keeps reverse index in sync — without this the UI would show stale
            // caller data right after a forced rebuild.
            await reverse.RebuildAsync();
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

        // Text grep across source files. Complements the IL-walked call graph: when the walker
        // misses something (logger calls hidden by namespace filter, dynamic dispatch, manual
        // `nameof()` references, etc.) the user can still find every textual mention of an
        // identifier. Limited to files under the host content root + .cs/.razor extensions.
        api.MapGet("/source/grep", (string q, int? maxHits, Microsoft.Extensions.Hosting.IHostEnvironment env) =>
        {
            if (string.IsNullOrWhiteSpace(q)) return Results.BadRequest(new { error = "q required" });
            if (q.Length < 2) return Results.BadRequest(new { error = "q too short (min 2 chars)" });

            // Start at the content root and walk up to its enclosing solution / repo dir so the
            // search sees sibling projects (PVC.WebApi → ../.. covers the whole PVC_WS tree).
            string root;
            try { root = System.IO.Path.GetFullPath(env.ContentRootPath); }
            catch { return Results.Problem("content root unresolvable"); }
            for (int i = 0; i < 4; i++)
            {
                var parent = System.IO.Directory.GetParent(root);
                if (parent is null) break;
                root = parent.FullName;
            }

            var cap = Math.Clamp(maxHits ?? 200, 1, 1000);
            var hits = new List<object>(cap);
            var ignoreDirs = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                "bin", "obj", "node_modules", "dist", ".git", ".vs", ".idea",
            };

            try
            {
                var queue = new Queue<string>();
                queue.Enqueue(root);
                while (queue.Count > 0 && hits.Count < cap)
                {
                    var dir = queue.Dequeue();
                    string[] subdirs;
                    try { subdirs = System.IO.Directory.GetDirectories(dir); } catch { continue; }
                    foreach (var s in subdirs)
                    {
                        var name = System.IO.Path.GetFileName(s);
                        if (ignoreDirs.Contains(name)) continue;
                        queue.Enqueue(s);
                    }
                    string[] files;
                    try { files = System.IO.Directory.GetFiles(dir, "*.cs"); } catch { continue; }
                    foreach (var file in files)
                    {
                        if (hits.Count >= cap) break;
                        string[] lines;
                        try { lines = System.IO.File.ReadAllLines(file); } catch { continue; }
                        for (int i = 0; i < lines.Length && hits.Count < cap; i++)
                        {
                            var line = lines[i];
                            if (line.IndexOf(q, StringComparison.Ordinal) < 0) continue;
                            hits.Add(new
                            {
                                path = file,
                                line = i + 1,
                                preview = line.Trim().Length > 200 ? line.Trim()[..200] + "…" : line.Trim()
                            });
                        }
                    }
                }
            }
            catch (Exception ex) { return Results.Problem(ex.Message); }

            return Results.Json(new { query = q, root, capped = hits.Count >= cap, hits }, Json);
        }).WithMetadata(new ExploreIgnoreAttribute()).ExcludeFromDescription();

        // Reverse fan-in for a single service: "which endpoints (directly + transitively)
        // end up here?" plus the immediate-parent services that route into it. Query param
        // because service ids are dot-separated fully-qualified type names.
        api.MapGet("/services/callers", async (string id, IReverseCallIndexService rev, IOptions<APICoverOptions> o) =>
        {
            if (!o.Value.EnableCallGraphInspection) return Results.NotFound();
            if (string.IsNullOrWhiteSpace(id)) return Results.BadRequest(new { error = "id required" });
            var dto = await rev.GetCallersAsync(id);
            return dto is null ? Results.NotFound() : Results.Json(dto, Json);
        });

        // Method-granular reverse fan-in: "which call sites hit exactly type.method?" Returns
        // only the matching sites — does not collapse them into a per-service summary.
        api.MapGet("/services/method-callers", async (string type, string method, IReverseCallIndexService rev, IOptions<APICoverOptions> o) =>
        {
            if (!o.Value.EnableCallGraphInspection) return Results.NotFound();
            if (string.IsNullOrWhiteSpace(type)) return Results.BadRequest(new { error = "type required" });
            if (string.IsNullOrWhiteSpace(method)) return Results.BadRequest(new { error = "method required" });
            var dto = await rev.GetMethodCallersAsync(type, method);
            return dto is null ? Results.NotFound() : Results.Json(dto, Json);
        });

        // Service map — topology view (nodes + edges + metrics + islands).
        api.MapGet("/service-map", async (IServiceMapService svc, IOptions<APICoverOptions> o) =>
        {
            if (!o.Value.EnableCallGraphInspection) return Results.NotFound();
            var map = await svc.BuildAsync();
            return Results.Json(map, Json);
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

        api.MapDelete("/scenarios/{id}", async (string id, IScenarioStore store, FilesystemRunHistoryStore historyStore) =>
        {
            await store.DeleteAsync(id);
            historyStore.DeleteHistory(id);
            return Results.NoContent();
        });

        // Per-scenario persisted run history (last 10 terminal runs).
        api.MapGet("/scenarios/{id}/history", (string id, FilesystemRunHistoryStore historyStore) =>
        {
            var runs = historyStore.ListHistory(id);
            var arr = runs.Select(r => new
            {
                id = r.Id,
                status = r.Status.ToString(),
                startedAt = r.StartedAt,
                completedAt = r.CompletedAt,
                nodeCount = r.NodeResults.Count,
                failedNodeCount = r.NodeResults.Count(n => n.Status == NodeStatus.Failed),
                error = r.Error
            });
            return Results.Ok(arr);
        });

        api.MapGet("/scenarios/{id}/history/{runId}", (string id, string runId, FilesystemRunHistoryStore historyStore) =>
        {
            var run = historyStore.ListHistory(id).FirstOrDefault(r => r.Id == runId);
            return run is null ? Results.NotFound() : Results.Ok(run);
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

        // Recent commit history with scenario-coverage tagging. The home dashboard
        // renders this as a horizontal timeline so the user can see, at a glance,
        // which commits arrived after the last scenario update — i.e. what code
        // has shipped since we last produced or refreshed flows for it.
        api.MapGet("/git/log", async (int? take, IScenarioStore store, Microsoft.Extensions.Hosting.IHostEnvironment env) =>
        {
            var n = Math.Clamp(take ?? 25, 1, 100);
            var commits = GitLog.Read(env.ContentRootPath, n);
            DateTimeOffset? lastScenario = null;
            foreach (var s in await store.ListAsync())
            {
                if (lastScenario is null || s.UpdatedAt > lastScenario) lastScenario = s.UpdatedAt;
            }
            var result = commits.Select(c => new
            {
                sha = c.Sha,
                shortSha = c.Sha.Length >= 7 ? c.Sha[..7] : c.Sha,
                subject = c.Subject,
                author = c.Author,
                date = c.Date,
                traced = lastScenario.HasValue && c.Date <= lastScenario.Value,
            }).ToArray();
            return Results.Json(new { commits = result, lastScenarioUpdate = lastScenario }, Json);
        });

        // Per-commit detail — files changed + per-file numstat + unified patch. Used
        // by the home timeline's expanded view so the user can see what changed in a
        // commit without dropping to the terminal.
        api.MapGet("/git/commit/{sha}", (string sha, Microsoft.Extensions.Hosting.IHostEnvironment env) =>
        {
            var detail = GitLog.ReadCommit(env.ContentRootPath, sha);
            return detail is null ? Results.NotFound() : Results.Json(detail, Json);
        });

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
                // Race the bus subscription against a 15s heartbeat ticker so the connection
                // doesn't go quiet for long enough that intermediaries (proxies, load balancers)
                // drop it as idle. Heartbeats are SSE comment lines (`:keepalive`) per spec —
                // the browser EventSource ignores them but the bytes keep the channel alive.
                var ct = ctx.RequestAborted;
                await using var enumerator = bus.SubscribeAsync(id, ct).GetAsyncEnumerator(ct);
                var nextTask = enumerator.MoveNextAsync().AsTask();
                while (!ct.IsCancellationRequested)
                {
                    var heartbeatTask = Task.Delay(TimeSpan.FromSeconds(15), ct);
                    var winner = await Task.WhenAny(nextTask, heartbeatTask);
                    if (winner == heartbeatTask)
                    {
                        await WriteHeartbeat(ctx);
                        continue;
                    }
                    if (!nextTask.Result) break;
                    var evt = enumerator.Current;
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
                    nextTask = enumerator.MoveNextAsync().AsTask();
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

        static async Task WriteHeartbeat(HttpContext ctx)
        {
            // SSE comment line — recognised by spec, ignored by EventSource, keeps the
            // connection alive across idle proxies.
            await ctx.Response.WriteAsync(":heartbeat\n\n");
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
