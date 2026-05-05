using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using APICover;
using APICover.Abstractions.Models;
using APICover.Abstractions.Services;
using APICover.Engine;
using APICover.Storage.Postgres;

namespace APICover.IntegrationTests;

/// <summary>
/// Postgres-backed scenario + run store tests. Requires a reachable Postgres instance —
/// reads <c>APICOVER_TEST_PG</c> env var or falls back to the local <c>apicover_test</c> db.
/// Skipped (with <see cref="SkipException"/>) when Postgres isn't reachable so CI without
/// a database can still pass.
/// </summary>
public class PostgresStorageTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _fixture;
    public PostgresStorageTests(PostgresFixture fixture) => _fixture = fixture;

    [SkippableFact]
    public async Task Scenario_round_trips_through_postgres()
    {
        Skip.IfNot(_fixture.Available, _fixture.SkipReason);

        var scenario = new Scenario
        {
            Id = $"scn-{Guid.NewGuid():N}",
            Name = "Round trip",
            Nodes =
            {
                new ApiNode { Id = "a", Method = "GET", Path = "/" }
            }
        };
        await _fixture.ScenarioStore.SaveAsync(scenario);

        var fetched = await _fixture.ScenarioStore.GetAsync(scenario.Id);
        Assert.NotNull(fetched);
        Assert.Equal(scenario.Name, fetched!.Name);
        Assert.Single(fetched.Nodes);
        Assert.Equal("a", fetched.Nodes[0].Id);

        await _fixture.ScenarioStore.DeleteAsync(scenario.Id);
        Assert.Null(await _fixture.ScenarioStore.GetAsync(scenario.Id));
    }

    [SkippableFact]
    public async Task Run_round_trips_and_lists_by_scenario_id()
    {
        Skip.IfNot(_fixture.Available, _fixture.SkipReason);

        var scenarioId = $"scn-{Guid.NewGuid():N}";
        var run1 = new Run { Id = Guid.NewGuid().ToString("N"), ScenarioId = scenarioId, Status = RunStatus.Running };
        var run2 = new Run { Id = Guid.NewGuid().ToString("N"), ScenarioId = scenarioId, Status = RunStatus.Succeeded };
        await _fixture.RunStore.SaveAsync(run1);
        await _fixture.RunStore.SaveAsync(run2);

        var fetched = await _fixture.RunStore.GetAsync(run1.Id);
        Assert.NotNull(fetched);
        Assert.Equal(scenarioId, fetched!.ScenarioId);

        var list = await _fixture.RunStore.ListAsync(scenarioId);
        Assert.Equal(2, list.Count);

        await _fixture.RunStore.DeleteAsync(run1.Id);
        await _fixture.RunStore.DeleteAsync(run2.Id);
    }

    [SkippableFact]
    public async Task Sample_app_with_postgres_storage_runs_scenario_e2e()
    {
        Skip.IfNot(_fixture.Available, _fixture.SkipReason);

        // Spin up the sample app with the Postgres provider replacing the in-memory defaults.
        await using var factory = new PostgresSampleFactory(_fixture.ConnectionString!);
        var client = factory.CreateClient();

        var scenarioId = $"e2e-{Guid.NewGuid():N}";
        var scenarioJson = $$"""
        {
            "id": "{{scenarioId}}",
            "name": "Postgres E2E",
            "nodes": [
                { "id": "list", "method": "GET", "path": "/users" }
            ],
            "edges": []
        }
        """;
        (await client.PutAsync($"/apicover/api/scenarios/{scenarioId}",
            new StringContent(scenarioJson, System.Text.Encoding.UTF8, "application/json")))
            .EnsureSuccessStatusCode();

        var startResponse = await client.PostAsync(
            $"/apicover/api/scenarios/{scenarioId}/runs",
            new StringContent("{\"breakpointsEnabled\":false}", System.Text.Encoding.UTF8, "application/json"));
        startResponse.EnsureSuccessStatusCode();

        // Verify it landed in the actual Postgres tables.
        await using var ctx = factory.Services.GetRequiredService<IDbContextFactory<PostgresStorageContext>>().CreateDbContext();
        Assert.True(await ctx.Scenarios.AnyAsync(s => s.Id == scenarioId));

        // Cleanup.
        await client.DeleteAsync($"/apicover/api/scenarios/{scenarioId}");
    }
}

public sealed class PostgresFixture : IAsyncLifetime
{
    public string? ConnectionString { get; private set; }
    public bool Available { get; private set; }
    public string SkipReason { get; private set; } = "Postgres not reachable.";
    public IScenarioStore ScenarioStore { get; private set; } = null!;
    public IRunStore RunStore { get; private set; } = null!;

    private ServiceProvider? _provider;

    public async Task InitializeAsync()
    {
        ConnectionString = Environment.GetEnvironmentVariable("APICOVER_TEST_PG")
            ?? "Host=localhost;Database=apicover_test;Username=postgres";

        try
        {
            var services = new ServiceCollection();
            services.AddLogging();
            services.AddDbContextFactory<PostgresStorageContext>(o => o.UseNpgsql(ConnectionString));
            services.AddSingleton<IScenarioStore, PostgresScenarioStore>();
            services.AddSingleton<IRunStore, PostgresRunStore>();
            _provider = services.BuildServiceProvider();

            var ctxFactory = _provider.GetRequiredService<IDbContextFactory<PostgresStorageContext>>();
            await using var ctx = await ctxFactory.CreateDbContextAsync();
            await ctx.Database.EnsureCreatedAsync();

            ScenarioStore = _provider.GetRequiredService<IScenarioStore>();
            RunStore = _provider.GetRequiredService<IRunStore>();
            Available = true;
        }
        catch (Exception ex)
        {
            Available = false;
            SkipReason = $"Postgres not reachable ({ex.GetType().Name}: {ex.Message}). Set APICOVER_TEST_PG to override.";
        }
    }

    public async Task DisposeAsync()
    {
        if (_provider is not null)
        {
            await _provider.DisposeAsync();
        }
    }
}

public sealed class PostgresSampleFactory : WebApplicationFactory<Program>
{
    private readonly string _connectionString;
    public PostgresSampleFactory(string connectionString) => _connectionString = connectionString;

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.ConfigureTestServices(services =>
        {
            services.AddAPICoverPostgresStorage(_connectionString);
            services.AddHttpClient(ScenarioEngine.HttpClientNamePublic)
                .ConfigurePrimaryHttpMessageHandler(() => Server.CreateHandler())
                .ConfigureHttpClient(c => c.BaseAddress = Server.BaseAddress);
        });
    }
}
