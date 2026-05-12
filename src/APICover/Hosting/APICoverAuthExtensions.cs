using APICover.Abstractions.Services;
using Microsoft.Extensions.DependencyInjection;

namespace APICover.Hosting;

/// <summary>
/// Convenience extensions for registering <see cref="IAPICoverAuthProvider"/> implementations.
/// </summary>
public static class APICoverAuthExtensions
{
    /// <summary>
    /// Register a custom auth provider type (transient lifetime — resolved per outbound request).
    /// </summary>
    public static IServiceCollection AddAPICoverAuthProvider<TProvider>(this IServiceCollection services)
        where TProvider : class, IAPICoverAuthProvider
    {
        services.AddTransient<IAPICoverAuthProvider, TProvider>();
        return services;
    }

    /// <summary>
    /// Register a callback that produces an Authorization header value (bearer or otherwise) for
    /// every outbound engine request. Async-aware. Use this for dev tokens / static bearer tokens.
    /// Return null to skip.
    /// </summary>
    public static IServiceCollection AddAPICoverBearerToken(
        this IServiceCollection services,
        Func<HttpRequestMessage, CancellationToken, ValueTask<string?>> tokenFactory)
    {
        services.AddTransient<IAPICoverAuthProvider>(_ => new BearerTokenAuthProvider(tokenFactory));
        return services;
    }

    /// <summary>
    /// Register a static bearer token. Useful for local dev / impersonation scenarios where the
    /// engine should call into protected endpoints with a fixed credential.
    /// </summary>
    public static IServiceCollection AddAPICoverBearerToken(this IServiceCollection services, string token)
    {
        return services.AddAPICoverBearerToken((_, _) => ValueTask.FromResult<string?>($"Bearer {token}"));
    }
}

internal sealed class BearerTokenAuthProvider : IAPICoverAuthProvider
{
    private readonly Func<HttpRequestMessage, CancellationToken, ValueTask<string?>> _factory;

    public BearerTokenAuthProvider(Func<HttpRequestMessage, CancellationToken, ValueTask<string?>> factory)
    {
        _factory = factory;
    }

    public string HeaderName => "Authorization";

    public ValueTask<string?> GetHeaderValueAsync(HttpRequestMessage request, CancellationToken ct)
        => _factory(request, ct);
}
