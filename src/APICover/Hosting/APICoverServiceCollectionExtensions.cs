using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using APICover.Abstractions.Discovery;
using APICover.Abstractions.Services;
using APICover.Discovery;
using APICover.Discovery.CallGraph;
using APICover.Endpoints;
using APICover.Engine;
using APICover.Engine.Breakpoints;
using APICover.Storage;
using APICover.UI;

namespace APICover.Hosting;

/// <summary>
/// DI registration and middleware wire-up entry points. Mirrors the Swashbuckle ergonomic:
/// <c>builder.Services.AddAPICover(opts =&gt; …)</c> followed by
/// <c>app.UseAPICover()</c>.
/// </summary>
public static class APICoverServiceCollectionExtensions
{
    public static IServiceCollection AddAPICover(this IServiceCollection services,
        Action<APICoverOptions>? configure = null)
    {
        ArgumentNullException.ThrowIfNull(services);

        if (configure is not null)
        {
            services.Configure(configure);
        }
        else
        {
            services.AddOptions<APICoverOptions>();
        }

        services.AddHttpClient(ScenarioEngine.HttpClientName)
            .ConfigureHttpClient((sp, client) =>
            {
                var addr = sp.GetRequiredService<IOptions<APICoverOptions>>().Value.HostBaseAddress;
                if (addr is not null) client.BaseAddress = addr;
            });

        services.TryAddSingleton<IRuleEvaluator, JsonLogicRuleEvaluator>();
        services.TryAddSingleton<DefaultBreakpointController>();
        services.TryAddSingleton<IBreakpointController>(sp => sp.GetRequiredService<DefaultBreakpointController>());
        services.TryAddSingleton<IScenarioStore, InMemoryScenarioStore>();
        services.TryAddSingleton<IRunStore, InMemoryRunStore>();
        services.TryAddSingleton<IRunEventBus, InMemoryRunEventBus>();
        // Discovery is registered as a singleton instance once; both IEndpointDiscoveryService
        // and IEndpointMethodResolver alias to the same implementation so the call-graph walker
        // can pull MethodInfo for an endpoint without a separate registration / re-walk.
        services.TryAddSingleton<ApiExplorerDiscoveryService>(sp =>
            new ApiExplorerDiscoveryService(
                sp.GetRequiredService<Microsoft.AspNetCore.Mvc.ApiExplorer.IApiDescriptionGroupCollectionProvider>(),
                sp.GetServices<Microsoft.AspNetCore.Routing.EndpointDataSource>()));
        services.TryAddSingleton<IEndpointDiscoveryService>(sp => sp.GetRequiredService<ApiExplorerDiscoveryService>());
        services.TryAddSingleton<IEndpointMethodResolver>(sp => sp.GetRequiredService<ApiExplorerDiscoveryService>());
        services.TryAddSingleton<IScenarioEngine, ScenarioEngine>();

        // Call-graph inspection. Cost is zero unless EnableCallGraphInspection is true:
        // the snapshot enumerates lazily, the walker runs on demand, the warmup hosted service
        // bails immediately when the option is off.
        services.TryAddSingleton<IServiceCollectionSnapshot>(_ => ServiceCollectionSnapshot.Build(services));
        services.TryAddSingleton<ICallGraphStore, InMemoryCallGraphStore>();
        services.TryAddSingleton<PdbResolver>();
        services.TryAddSingleton<IlWalker>();
        services.TryAddSingleton<ICallGraphService, CallGraphService>();
        services.TryAddSingleton<IServiceCatalogService, ServiceCatalogService>();
        services.TryAddSingleton<IServiceMapService, ServiceMapBuilder>();
        services.AddHostedService<CallGraphWarmupHostedService>();

        return services;
    }
}

public static class APICoverApplicationBuilderExtensions
{
    /// <summary>
    /// Mounts the inspector at <see cref="APICoverOptions.PathPrefix"/>. Resolves the
    /// host base address from <see cref="IServer"/> features so the engine can call back into
    /// the host's own endpoints.
    /// </summary>
    public static IApplicationBuilder UseAPICover(this IApplicationBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);

        var options = app.ApplicationServices.GetRequiredService<IOptions<APICoverOptions>>().Value;

        if (options.HostBaseAddress is null)
        {
            // Defer base-address resolution to first request via a lifetime-aware lookup.
            ResolveHostBaseAddressLazy(app, options);
        }

        var prefix = options.PathPrefix.TrimEnd('/');

        var uiProviders = app.ApplicationServices.GetServices<IAPICoverUiProvider>().ToList();
        var endpointExtensions = app.ApplicationServices.GetServices<IAPICoverEndpointExtension>().ToList();

        app.UseRouting();
        app.UseEndpoints(endpoints =>
        {
            APICoverEndpoints.MapAll(endpoints, prefix);
            foreach (var extension in endpointExtensions)
            {
                extension.MapEndpoints(endpoints, prefix);
            }
            foreach (var provider in uiProviders)
            {
                provider.MapUi(endpoints, prefix);
            }
        });

        return app;
    }

    private static void ResolveHostBaseAddressLazy(IApplicationBuilder app, APICoverOptions options)
    {
        var lifetime = app.ApplicationServices.GetService<IHostApplicationLifetime>();
        if (lifetime is null) return;

        lifetime.ApplicationStarted.Register(() =>
        {
            try
            {
                var server = app.ApplicationServices.GetRequiredService<IServer>();
                var addressFeature = server.Features.Get<IServerAddressesFeature>();
                var first = addressFeature?.Addresses.FirstOrDefault();
                if (!string.IsNullOrEmpty(first))
                {
                    var normalised = first
                        .Replace("[::]", "localhost", StringComparison.Ordinal)
                        .Replace("0.0.0.0", "localhost", StringComparison.Ordinal)
                        .Replace("*", "localhost", StringComparison.Ordinal);
                    options.HostBaseAddress = new Uri(normalised);

                    // Configure named HttpClient base address.
                    var factory = app.ApplicationServices.GetRequiredService<IHttpClientFactory>();
                    var client = factory.CreateClient(ScenarioEngine.HttpClientName);
                    client.BaseAddress = options.HostBaseAddress;
                }
            }
            catch
            {
                // Swallow; integration tests use WebApplicationFactory which sets BaseAddress directly.
            }
        });
    }
}
