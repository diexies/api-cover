using System.ComponentModel;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using ModelContextProtocol.Server;
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

        // The SDK auto-discovers [McpServerToolType] classes in the assembly so the
        // catalogue stays declarative — adding a new tools class just registers it.
        var mcp = services.AddMcpServer().WithToolsFromAssembly(typeof(APICoverMcpServiceCollectionExtensions).Assembly);

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
        apiGroup.MapGet("/info", (HttpRequest request, APICoverMcpOptions opts) =>
        {
            var baseUrl = $"{request.Scheme}://{request.Host.Value}{prefix}/mcp";
            var tools = ToolCatalogue.Value;
            var info = new McpInfo(
                Enabled: opts.EnableHttp,
                HttpUrl: baseUrl,
                StdioCommand: "apicover-mcp",
                RequireAuth: opts.RequireAuth,
                Tools: tools,
                Playbook: McpPlaybook.Markdown);
            return Results.Json(info, JsonOptions);
        });

        // Plain-text playbook copy — handy for users who prefer wget/curl to
        // pasting via the UI. Returns the same markdown the /info endpoint
        // ships in its JSON body.
        apiGroup.MapGet("/playbook", () =>
            Results.Text(McpPlaybook.Markdown, "text/markdown; charset=utf-8"));
    }

    private static readonly Lazy<IReadOnlyList<McpToolMeta>> ToolCatalogue = new(BuildCatalogue);

    private static IReadOnlyList<McpToolMeta> BuildCatalogue()
    {
        // Reflect over our own assembly: every method tagged with [McpServerTool]
        // contributes one entry. Description comes from [Description] when set, the
        // method name as fallback. Result is cached for the process lifetime since
        // the assembly is immutable.
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
                var description = method.GetCustomAttribute<DescriptionAttribute>()?.Description ?? name;
                list.Add(new McpToolMeta(name, description));
            }
        }
        return list.OrderBy(t => t.Name, StringComparer.Ordinal).ToArray();
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
    string Playbook);

internal sealed record McpToolMeta(string Name, string Description);
