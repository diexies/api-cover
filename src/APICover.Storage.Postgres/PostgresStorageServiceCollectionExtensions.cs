using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using APICover.Abstractions.Services;

namespace APICover.Storage.Postgres;

/// <summary>DI plumbing for the Postgres storage provider. Replaces the in-memory defaults
/// registered by <c>AddAPICover()</c> when called afterwards.</summary>
public static class PostgresStorageServiceCollectionExtensions
{
    /// <summary>
    /// Registers <see cref="PostgresScenarioStore"/> and <see cref="PostgresRunStore"/> against
    /// the given Postgres connection string. Adds an <see cref="IHostedService"/> that calls
    /// <c>EnsureCreated()</c> at startup so the two tables exist on first run. For production
    /// migrations switch to <c>dotnet ef migrations</c> and remove the hosted service.
    /// </summary>
    public static IServiceCollection AddAPICoverPostgresStorage(
        this IServiceCollection services, string connectionString)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentException.ThrowIfNullOrEmpty(connectionString);

        services.AddDbContextFactory<PostgresStorageContext>(opts => opts.UseNpgsql(connectionString));

        // Replace in-memory defaults with the Postgres-backed implementations.
        services.RemoveAll<IScenarioStore>();
        services.RemoveAll<IRunStore>();
        services.AddSingleton<IScenarioStore, PostgresScenarioStore>();
        services.AddSingleton<IRunStore, PostgresRunStore>();

        services.AddHostedService<PostgresStorageInitializer>();

        return services;
    }
}

internal sealed class PostgresStorageInitializer : IHostedService
{
    private readonly IDbContextFactory<PostgresStorageContext> _ctxFactory;

    public PostgresStorageInitializer(IDbContextFactory<PostgresStorageContext> ctxFactory)
        => _ctxFactory = ctxFactory;

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        await using var ctx = await _ctxFactory.CreateDbContextAsync(cancellationToken);
        await ctx.Database.EnsureCreatedAsync(cancellationToken);
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
