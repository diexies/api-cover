using System.ComponentModel;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using ModelContextProtocol.Server;
using APICover.Abstractions.Models;
using APICover.Abstractions.Services;
using APICover.Abstractions.Validation;
using APICover.Hosting;

namespace APICover.Mcp.Hosting;

/// <summary>
/// Configuration for the APICover MCP add-on. The MVP exposes the same tool catalog
/// regardless of transport — the user picks how clients connect via the flags below.
/// </summary>
public sealed class APICoverMcpOptions
{
    /// <summary>
    /// Mount the MCP server on the inspector's HTTP host at <c>{prefix}/mcp</c>.
    /// True by default — IDEs that speak Streamable HTTP (Cursor, VS Code Copilot,
    /// Cline, Claude Desktop, Windsurf, etc.) connect via this URL with no extra setup.
    /// </summary>
    public bool EnableHttp { get; set; } = true;

    /// <summary>
    /// Require authentication on the HTTP transport. Default false because the
    /// inspector typically lives behind the host's existing firewall / reverse proxy.
    /// When true, <c>RequireAuthorization()</c> is applied to the MCP endpoints —
    /// configure an auth scheme (e.g. <c>AddJwtBearer</c>) before calling
    /// <see cref="APICoverMcpServiceCollectionExtensions.AddAPICoverMcp"/>.
    /// </summary>
    public bool RequireAuth { get; set; } = false;
}

/// <summary>
/// DI registration for the MCP server. Call AFTER <c>AddAPICover()</c> so we can
/// share <c>IScenarioStore</c>, <c>IRunStore</c>, <c>IEndpointDiscoveryService</c>,
/// etc. <c>AddAPICoverAgent()</c> is also required when the memory tools are wanted —
/// they're skipped at registration time if <c>IAgentMemoryStore</c> isn't bound.
/// </summary>
public static class APICoverMcpServiceCollectionExtensions
{
    public static IServiceCollection AddAPICoverMcp(
        this IServiceCollection services,
        Action<APICoverMcpOptions>? configure = null)
    {
        ArgumentNullException.ThrowIfNull(services);

        var options = new APICoverMcpOptions();
        configure?.Invoke(options);
        services.AddSingleton(options);
        services.AddSingleton<LiveMcpConnectionRegistry>();

        // The SDK auto-discovers [McpServerToolType] classes in the assembly so the
        // catalogue stays declarative — adding a new tools class just registers it.
        var mcp = services.AddMcpServer()
            .WithToolsFromAssembly(typeof(APICoverMcpServiceCollectionExtensions).Assembly)
            .WithPromptsFromAssembly(typeof(APICoverMcpServiceCollectionExtensions).Assembly);

        if (options.EnableHttp)
        {
            // Streamable HTTP is the post-2025-06 transport. Legacy /sse stays disabled
            // because the SDK does the same in 1.2.0+ and modern IDEs have moved on.
            mcp.WithHttpTransport();
            services.AddSingleton<IAPICoverEndpointExtension, McpEndpointExtension>();
        }

        return services;
    }
}

/// <summary>
/// Plugs <c>app.MapMcp()</c> into APICover's existing endpoint pipeline so the MCP
/// surface lives at <c>{prefix}/mcp</c> alongside the rest of the inspector API.
/// </summary>
internal sealed class McpEndpointExtension : IAPICoverEndpointExtension
{
    private readonly APICoverMcpOptions _options;

    public McpEndpointExtension(APICoverMcpOptions options) { _options = options; }

    public string Name => "mcp";

    public void MapEndpoints(IEndpointRouteBuilder endpoints, string prefix)
    {
        var mcpGroup = endpoints.MapGroup($"{prefix}/mcp");
        // Tap every MCP request into the live-connection registry. Filter runs before
        // the SDK's tool dispatch and never throws — failures swallowed so transport stays clean.
        mcpGroup.AddEndpointFilter(async (ctx, next) =>
        {
            try
            {
                var registry = ctx.HttpContext.RequestServices.GetService<LiveMcpConnectionRegistry>();
                registry?.Record(ctx.HttpContext);
            }
            catch { /* never break transport */ }
            return await next(ctx);
        });
        // MapMcp adds the streamable-HTTP routes (POST + GET for the same path).
        mcpGroup.MapMcp();
        if (_options.RequireAuth)
        {
            mcpGroup.RequireAuthorization();
        }

        // Companion JSON metadata route — used by the in-app "MCP" tab to render
        // tool catalogue + IDE connect snippets without speaking JSON-RPC itself.
        // Mounted under `/apicover/api/mcp/...` so it shares the inspector's
        // existing API base path and CORS / auth conventions.
        var apiGroup = endpoints.MapGroup($"{prefix}/api/mcp");
        apiGroup.MapGet("/info", async (HttpRequest request, APICoverMcpOptions opts, LiveMcpConnectionRegistry registry, ICustomToolStore customStore, CancellationToken ct) =>
        {
            var baseUrl = $"{request.Scheme}://{request.Host.Value}{prefix}/mcp";
            var built = BuildCatalogue();
            var custom = await customStore.ListAsync(ct);
            var customMeta = custom.Select(d => new McpToolMeta(
                Name: d.Name,
                Description: d.Description,
                WhenTriggered: string.IsNullOrWhiteSpace(d.WhenTriggered) ? null : d.WhenTriggered,
                Category: "custom",
                ParamsSchema: JsonNode.Parse(d.ParamsSchema.GetRawText()),
                IsCustom: true)).ToArray();
            var tools = built.Concat(customMeta).OrderBy(t => t.Name, StringComparer.Ordinal).ToArray();
            var info = new McpInfo(
                Enabled: opts.EnableHttp,
                HttpUrl: baseUrl,
                StdioCommand: "apicover-mcp",
                RequireAuth: opts.RequireAuth,
                Tools: tools,
                LiveConnections: registry.Snapshot(),
                Playbook: McpPlaybook.Markdown);
            return Results.Json(info, JsonOptions);
        });

        // Plain-text playbook copy — handy for users who prefer wget/curl to
        // pasting via the UI. Returns the same markdown the /info endpoint
        // ships in its JSON body.
        apiGroup.MapGet("/playbook", () =>
            Results.Text(McpPlaybook.Markdown, "text/markdown; charset=utf-8"));

        // Custom tool CRUD. POST validates via CustomToolValidator; persists to disk
        // via FilesystemCustomToolStore. Clients must restart their MCP session to see
        // newly-registered tools as discrete tools/list entries — until then the
        // in-app agent can invoke them via the dispatcher fallthrough, and IDE clients
        // can use the `custom.invoke` proxy tool.
        apiGroup.MapGet("/custom-tools", async (ICustomToolStore store, CancellationToken ct) =>
        {
            var list = await store.ListAsync(ct);
            return Results.Json(new { count = list.Count, tools = list }, JsonOptions);
        });
        apiGroup.MapPost("/custom-tools", async (CustomToolDefinition def, ICustomToolStore store, CancellationToken ct) =>
        {
            var validation = CustomToolValidator.Validate(def);
            if (!validation.IsValid)
            {
                return Results.Json(new { ok = false, errors = validation.Errors }, JsonOptions, statusCode: 400);
            }
            await store.SaveAsync(def, ct);
            return Results.Json(new { ok = true, name = def.Name, requiresRestart = true }, JsonOptions);
        });
        apiGroup.MapDelete("/custom-tools/{name}", async (string name, ICustomToolStore store, CancellationToken ct) =>
        {
            await store.DeleteAsync(name, ct);
            return Results.Json(new { ok = true, name }, JsonOptions);
        });
    }

    /// <summary>
    /// Reflects over our assembly: every method tagged with [McpServerTool] contributes one entry.
    /// The raw [Description] starts with an optional "WHEN: …\n\n" line — we parse it out into
    /// a separate field so the UI can render a "when to trigger" chip distinct from the body.
    /// Category is derived from the part of the tool name before the first dot.
    /// ParamsSchema is built by reflecting MethodInfo parameters, skipping DI types and CancellationToken.
    /// Rebuilt per /info call so user-defined custom tools (registered post-boot) merge in.
    /// </summary>
    private static IReadOnlyList<McpToolMeta> BuildCatalogue()
    {
        var asm = typeof(McpEndpointExtension).Assembly;
        var list = new List<McpToolMeta>();
        foreach (var type in asm.GetTypes())
        {
            if (!type.IsClass || type.GetCustomAttribute<McpServerToolTypeAttribute>() is null) continue;
            foreach (var method in type.GetMethods(BindingFlags.Public | BindingFlags.Static | BindingFlags.Instance))
            {
                var toolAttr = method.GetCustomAttribute<McpServerToolAttribute>();
                if (toolAttr is null) continue;
                var name = !string.IsNullOrEmpty(toolAttr.Name) ? toolAttr.Name : method.Name;
                var rawDescription = method.GetCustomAttribute<DescriptionAttribute>()?.Description ?? name;
                var (when, description) = SplitWhen(rawDescription);
                var category = ExtractCategory(name);
                var schema = BuildParamsSchema(method);
                list.Add(new McpToolMeta(name, description, when, category, schema, IsCustom: false));
            }
        }
        return list.OrderBy(t => t.Name, StringComparer.Ordinal).ToArray();
    }

    /// <summary>
    /// Splits an "WHEN: <line>\n\n<rest>" prefix off a description. Returns null `when` if missing.
    /// </summary>
    internal static (string? When, string Description) SplitWhen(string raw)
    {
        if (string.IsNullOrEmpty(raw) || !raw.StartsWith("WHEN:", StringComparison.Ordinal))
            return (null, raw);
        var idx = raw.IndexOf('\n');
        if (idx < 0) return (null, raw);
        var when = raw.Substring("WHEN:".Length, idx - "WHEN:".Length).Trim();
        var rest = raw[(idx + 1)..].TrimStart('\n');
        return (when.Length == 0 ? null : when, rest);
    }

    /// <summary>Tool name "scenarios.list" → "scenarios". Names without a dot fall to "general".</summary>
    internal static string ExtractCategory(string name)
    {
        var dot = name.IndexOf('.');
        return dot > 0 ? name[..dot] : "general";
    }

    /// <summary>
    /// Reflects method parameters into a JSON-Schema-ish object: { type:"object", properties:{...}, required:[...] }.
    /// Skips DI-injected types (anything not in the primitive/string/JsonElement allowlist) and CancellationToken.
    /// </summary>
    private static JsonNode? BuildParamsSchema(MethodInfo method)
    {
        var props = new JsonObject();
        var required = new JsonArray();
        var any = false;
        foreach (var p in method.GetParameters())
        {
            if (!IsUserFacingParam(p.ParameterType)) continue;
            any = true;
            var node = new JsonObject { ["type"] = MapJsonType(p.ParameterType) };
            var desc = p.GetCustomAttribute<DescriptionAttribute>()?.Description;
            if (!string.IsNullOrWhiteSpace(desc)) node["description"] = desc;
            props[p.Name ?? "_"] = node;
            if (!p.HasDefaultValue && !IsNullable(p)) required.Add(p.Name ?? "_");
        }
        if (!any) return null;
        var schema = new JsonObject { ["type"] = "object", ["properties"] = props };
        if (required.Count > 0) schema["required"] = required;
        return schema;
    }

    private static bool IsUserFacingParam(Type t)
    {
        if (t == typeof(CancellationToken)) return false;
        if (t == typeof(string) || t == typeof(int) || t == typeof(long) || t == typeof(bool) ||
            t == typeof(double) || t == typeof(float) || t == typeof(decimal) ||
            t == typeof(int?) || t == typeof(long?) || t == typeof(bool?) ||
            t == typeof(double?) || t == typeof(float?) || t == typeof(decimal?) ||
            t == typeof(JsonElement) || t == typeof(JsonElement?)) return true;
        if (t.IsGenericType && t.GetGenericTypeDefinition() == typeof(Dictionary<,>)) return true;
        return false;
    }

    private static string MapJsonType(Type t)
    {
        if (t == typeof(string)) return "string";
        if (t == typeof(bool) || t == typeof(bool?)) return "boolean";
        if (t == typeof(int) || t == typeof(long) || t == typeof(int?) || t == typeof(long?)) return "integer";
        if (t == typeof(double) || t == typeof(float) || t == typeof(decimal) ||
            t == typeof(double?) || t == typeof(float?) || t == typeof(decimal?)) return "number";
        if (t == typeof(JsonElement) || t == typeof(JsonElement?)) return "object";
        if (t.IsGenericType && t.GetGenericTypeDefinition() == typeof(Dictionary<,>)) return "object";
        return "string";
    }

    private static bool IsNullable(ParameterInfo p)
    {
        var t = p.ParameterType;
        if (Nullable.GetUnderlyingType(t) is not null) return true;
        // Reference types: best-effort via NullabilityInfoContext.
        if (!t.IsValueType)
        {
            try
            {
                var ctx = new NullabilityInfoContext();
                var info = ctx.Create(p);
                return info.WriteState == NullabilityState.Nullable || info.ReadState == NullabilityState.Nullable;
            }
            catch { return false; }
        }
        return false;
    }

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };
}

internal sealed record McpInfo(
    bool Enabled,
    string HttpUrl,
    string StdioCommand,
    bool RequireAuth,
    IReadOnlyList<McpToolMeta> Tools,
    IReadOnlyList<LiveConnection> LiveConnections,
    string Playbook);

internal sealed record McpToolMeta(
    string Name,
    string Description,
    string? WhenTriggered,
    string Category,
    JsonNode? ParamsSchema,
    bool IsCustom);

internal sealed record LiveConnection(
    string ClientId,
    string? UserAgent,
    string Ip,
    DateTimeOffset FirstSeen,
    DateTimeOffset LastSeen,
    int RequestCount);
