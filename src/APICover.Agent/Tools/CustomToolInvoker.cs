using System.Net.Http.Headers;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;
using APICover.Abstractions.Models;
using APICover.Abstractions.Services;
using APICover.Engine;

namespace APICover.Agent.Tools;

public interface ICustomToolInvoker
{
    /// <summary>
    /// Resolve <paramref name="toolName"/> against the custom tool store, interpolate args
    /// into url + body templates, and invoke against the host. Returns null when the tool
    /// is unknown so the dispatcher can fall through to its "unknown tool" error path.
    /// </summary>
    Task<JsonNode?> TryInvokeAsync(string toolName, JsonNode? input, CancellationToken ct = default);
}

/// <summary>
/// HTTP-proxy invoker for user-defined custom tools. Reuses the inspector's named HttpClient
/// (which already has the host base address + auth handler wired) so authorization headers
/// flow automatically. Template interpolation is JSON-safe: <c>{{paramName}}</c> in a body
/// template is replaced with the JSON-serialized arg value (string → quoted, object → nested
/// JSON) to prevent injection via raw concatenation. URL placeholders are URL-encoded.
/// </summary>
public sealed class CustomToolInvoker : ICustomToolInvoker
{
    private static readonly Regex PlaceholderRe = new(@"\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}", RegexOptions.Compiled);

    private readonly IHttpClientFactory _factory;
    private readonly ICustomToolStore _store;
    private readonly ILogger<CustomToolInvoker>? _log;

    public CustomToolInvoker(IHttpClientFactory factory, ICustomToolStore store, ILogger<CustomToolInvoker>? log = null)
    {
        _factory = factory;
        _store = store;
        _log = log;
    }

    public async Task<JsonNode?> TryInvokeAsync(string toolName, JsonNode? input, CancellationToken ct = default)
    {
        var def = await _store.GetAsync(toolName, ct).ConfigureAwait(false);
        if (def is null) return null;

        var args = input as JsonObject ?? new JsonObject();
        ValidateRequiredParams(def, args, out var missing);
        if (missing.Count > 0)
        {
            return new JsonObject
            {
                ["ok"] = false,
                ["error"] = $"missing required params: {string.Join(", ", missing)}",
            };
        }

        var url = InterpolateUrl(def.UrlTemplate, args);
        string? bodyText = null;
        if (!string.IsNullOrEmpty(def.BodyTemplate))
        {
            bodyText = InterpolateJsonBody(def.BodyTemplate, args);
        }

        using var req = new HttpRequestMessage(new HttpMethod(def.Method.ToUpperInvariant()), url);
        if (bodyText is not null)
        {
            req.Content = new StringContent(bodyText, Encoding.UTF8, "application/json");
        }
        if (def.Headers is not null)
        {
            foreach (var (k, v) in def.Headers)
            {
                // Try as content header first (e.g. Content-Type override) else request header.
                if (!req.Headers.TryAddWithoutValidation(k, v) && req.Content is not null)
                {
                    req.Content.Headers.TryAddWithoutValidation(k, v);
                }
            }
        }

        var client = _factory.CreateClient(ScenarioEngine.HttpClientNamePublic);
        try
        {
            using var resp = await client.SendAsync(req, ct).ConfigureAwait(false);
            var respBody = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            JsonNode? parsedBody = null;
            if (!string.IsNullOrWhiteSpace(respBody))
            {
                try { parsedBody = JsonNode.Parse(respBody); }
                catch (JsonException) { parsedBody = JsonValue.Create(respBody); }
            }
            return new JsonObject
            {
                ["ok"] = resp.IsSuccessStatusCode,
                ["status"] = (int)resp.StatusCode,
                ["body"] = parsedBody,
            };
        }
        catch (Exception ex)
        {
            _log?.LogWarning(ex, "Custom tool {Tool} invocation failed", toolName);
            return new JsonObject
            {
                ["ok"] = false,
                ["error"] = ex.Message,
            };
        }
    }

    private static void ValidateRequiredParams(CustomToolDefinition def, JsonObject args, out List<string> missing)
    {
        missing = new List<string>();
        if (def.ParamsSchema.ValueKind != JsonValueKind.Object) return;
        if (!def.ParamsSchema.TryGetProperty("required", out var req) || req.ValueKind != JsonValueKind.Array) return;
        foreach (var el in req.EnumerateArray())
        {
            var name = el.GetString();
            if (!string.IsNullOrEmpty(name) && (!args.ContainsKey(name) || args[name] is null))
                missing.Add(name);
        }
    }

    internal static string InterpolateUrl(string template, JsonObject args)
    {
        return PlaceholderRe.Replace(template, m =>
        {
            var key = m.Groups[1].Value;
            if (!args.TryGetPropertyValue(key, out var node) || node is null) return string.Empty;
            var raw = node is JsonValue v && v.TryGetValue<string>(out var s) ? s : node.ToJsonString();
            return UrlEncoder.Default.Encode(raw);
        });
    }

    internal static string InterpolateJsonBody(string template, JsonObject args)
    {
        return PlaceholderRe.Replace(template, m =>
        {
            var key = m.Groups[1].Value;
            if (!args.TryGetPropertyValue(key, out var node) || node is null) return "null";
            // JsonNode.ToJsonString already JSON-encodes (strings become "quoted", objects stay nested).
            return node.ToJsonString();
        });
    }
}
