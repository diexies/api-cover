using System.Reflection;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Extensions.DependencyInjection;
using APICover.UI;

namespace APICover.UI.Web;

/// <summary>
/// Serves the embedded React SPA bundle from <c>{prefix}/ui</c>. Assets ship as embedded
/// resources in this assembly so the host app needs zero filesystem dependencies — drop the
/// NuGet, call <c>AddAPICoverWebUI()</c>, browse <c>/apicover/ui</c>.
/// </summary>
public sealed class WebUiProvider : IAPICoverUiProvider
{
    private static readonly Assembly Assembly = typeof(WebUiProvider).Assembly;
    private static readonly FileExtensionContentTypeProvider ContentTypes = new();

    public string Name => "web";

    public void MapUi(IEndpointRouteBuilder endpoints, string prefix)
    {
        var uiPrefix = $"{prefix}/ui";

        endpoints.MapGet($"{uiPrefix}/{{**path}}", ctx =>
        {
            var path = (string?)ctx.Request.RouteValues["path"];
            return ServeAsset(ctx, string.IsNullOrEmpty(path) ? "index.html" : path);
        });
    }

    private static async Task ServeAsset(HttpContext ctx, string relativePath)
    {
        var resourceName = ResolveResourceName(relativePath);
        if (resourceName is null)
        {
            // SPA fallback: unknown path → serve index.html so client-side routing works.
            resourceName = ResolveResourceName("index.html");
            if (resourceName is null)
            {
                ctx.Response.StatusCode = StatusCodes.Status404NotFound;
                await ctx.Response.WriteAsync("UI bundle missing.");
                return;
            }
        }

        await using var stream = Assembly.GetManifestResourceStream(resourceName);
        if (stream is null)
        {
            ctx.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }

        ctx.Response.ContentType = GuessContentType(relativePath);
        ctx.Response.Headers.CacheControl = relativePath.StartsWith("assets/", StringComparison.Ordinal)
            ? "public, max-age=31536000, immutable"
            : "no-cache";
        await stream.CopyToAsync(ctx.Response.Body);
    }

    private static string? ResolveResourceName(string relativePath)
    {
        // LogicalName preserves the slash-separated "ui/<path>" exactly, so we look up by
        // direct match. Hashed asset names contain dots but no slashes, so this is unambiguous.
        var key = "ui/" + relativePath.Replace('\\', '/');
        return Assembly.GetManifestResourceNames()
            .FirstOrDefault(n => string.Equals(n, key, StringComparison.OrdinalIgnoreCase));
    }

    private static string GuessContentType(string path)
    {
        if (ContentTypes.TryGetContentType(path, out var ct)) return ct;
        return "application/octet-stream";
    }
}

public static class WebUiServiceCollectionExtensions
{
    /// <summary>Registers the embedded React UI provider. Mount becomes available under
    /// <c>{PathPrefix}/ui</c> after <c>UseAPICover()</c>.</summary>
    public static IServiceCollection AddAPICoverWebUI(this IServiceCollection services)
    {
        services.AddSingleton<IAPICoverUiProvider, WebUiProvider>();
        return services;
    }
}
