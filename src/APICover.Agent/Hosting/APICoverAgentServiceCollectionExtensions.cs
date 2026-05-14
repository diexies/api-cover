using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using APICover.Agent.Anthropic;
using APICover.Agent.Credentials;
using APICover.Agent.Endpoints;
using APICover.Agent.Engine;
using APICover.Agent.Memory;
using APICover.Agent.Sessions;
using APICover.Agent.Tools;
using APICover.Hosting;

namespace APICover.Agent.Hosting;

/// <summary>
/// DI registration for the embedded Claude agent. Call AFTER <c>AddAPICover()</c> so the
/// agent can resolve <c>IEndpointDiscoveryService</c>.
/// </summary>
public static class APICoverAgentServiceCollectionExtensions
{
    public static IServiceCollection AddAPICoverAgent(
        this IServiceCollection services,
        Action<AgentOptions>? configure = null)
    {
        ArgumentNullException.ThrowIfNull(services);

        if (configure is not null)
        {
            services.Configure(configure);
        }
        else
        {
            services.AddOptions<AgentOptions>();
        }

        services.AddDataProtection();

        services.AddHttpClient(AnthropicHttpClient.HttpClientName, _ => { });
        services.PostConfigure<Microsoft.Extensions.Http.HttpClientFactoryOptions>(
            AnthropicHttpClient.HttpClientName,
            options =>
            {
                options.HttpClientActions.Add(_ => { });
            });

        services.TryAddSingleton<MaxSubscriptionProbe>();
        services.TryAddSingleton<CredentialEncryption>();
        services.TryAddSingleton<IAgentCredentialStore, FilesystemAgentCredentialStore>();
        services.TryAddSingleton<IClaudeCredentialProvider, CredentialResolver>();

        services.TryAddSingleton<AnthropicHttpClient>(sp => new AnthropicHttpClient(
            sp.GetRequiredService<IHttpClientFactory>(),
            sp.GetRequiredService<IClaudeCredentialProvider>(),
            sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<AgentOptions>>()));
        services.TryAddSingleton<ClaudeCliBridge>();
        services.TryAddSingleton<IAnthropicClient, CompositeAnthropicClient>();

        services.TryAddSingleton<IAgentMemoryStore, FilesystemAgentMemoryStore>();
        services.TryAddSingleton<MemoryBootstrap>();
        services.TryAddSingleton<IAgentSessionStore, FilesystemAgentSessionStore>();
        services.TryAddSingleton<ICustomToolInvoker, CustomToolInvoker>();
        services.TryAddSingleton<ToolDispatcher>();
        services.TryAddSingleton<IAgentRunStore, InMemoryAgentRunStore>();
        services.TryAddSingleton<AgentBudgetTracker>();
        services.TryAddSingleton<AgentRunCoordinator>();

        // Configure the named HttpClient via a HostedService-free path: pull the options
        // when first resolved.
        services.AddHttpClient(AnthropicHttpClient.HttpClientName)
            .ConfigureHttpClient((sp, client) =>
            {
                var opts = sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<AgentOptions>>().Value;
                client.BaseAddress = opts.AnthropicBaseAddress;
                client.Timeout = TimeSpan.FromSeconds(opts.RequestTimeoutSeconds);
            });

        services.AddSingleton<IAPICoverEndpointExtension, AgentEndpointExtension>();

        // Background bootstrap: if memory is empty + credentials present at startup,
        // auto-fire a scan so the user lands on a populated workspace.
        services.AddHostedService<MemoryAutoBootstrap>();

        return services;
    }

    private sealed class AgentEndpointExtension : IAPICoverEndpointExtension
    {
        public string Name => "agent";

        public void MapEndpoints(IEndpointRouteBuilder endpoints, string prefix)
            => AgentEndpoints.MapAgent(endpoints, prefix);
    }
}
