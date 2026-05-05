using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;
using APICover.Abstractions.Models;
using APICover.Abstractions.Services;

namespace APICover.Storage.Postgres;

/// <summary>EF Core / Npgsql backed <see cref="IScenarioStore"/>. Scenario JSON lives in a
/// <c>jsonb</c> column; lookups go through the indexed primary key.</summary>
public sealed class PostgresScenarioStore : IScenarioStore
{
    private readonly IDbContextFactory<PostgresStorageContext> _ctxFactory;
    private readonly JsonSerializerOptions _json;

    public PostgresScenarioStore(IDbContextFactory<PostgresStorageContext> ctxFactory)
    {
        _ctxFactory = ctxFactory;
        _json = new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) }
        };
    }

    public async Task<IReadOnlyList<Scenario>> ListAsync(CancellationToken cancellationToken = default)
    {
        await using var ctx = await _ctxFactory.CreateDbContextAsync(cancellationToken);
        var rows = await ctx.Scenarios
            .OrderBy(s => s.Name)
            .AsNoTracking()
            .ToListAsync(cancellationToken);
        return rows.Select(r => r.ToScenario(_json)).ToList();
    }

    public async Task<Scenario?> GetAsync(string id, CancellationToken cancellationToken = default)
    {
        await using var ctx = await _ctxFactory.CreateDbContextAsync(cancellationToken);
        var row = await ctx.Scenarios.AsNoTracking().FirstOrDefaultAsync(s => s.Id == id, cancellationToken);
        return row?.ToScenario(_json);
    }

    public async Task SaveAsync(Scenario scenario, CancellationToken cancellationToken = default)
    {
        scenario.UpdatedAt = DateTimeOffset.UtcNow;
        await using var ctx = await _ctxFactory.CreateDbContextAsync(cancellationToken);
        var row = ScenarioRow.FromScenario(scenario, _json);
        var existing = await ctx.Scenarios.FirstOrDefaultAsync(s => s.Id == scenario.Id, cancellationToken);
        if (existing is null)
        {
            ctx.Scenarios.Add(row);
        }
        else
        {
            existing.Name = row.Name;
            existing.UpdatedAt = row.UpdatedAt;
            existing.Document = row.Document;
        }
        await ctx.SaveChangesAsync(cancellationToken);
    }

    public async Task DeleteAsync(string id, CancellationToken cancellationToken = default)
    {
        await using var ctx = await _ctxFactory.CreateDbContextAsync(cancellationToken);
        var row = await ctx.Scenarios.FirstOrDefaultAsync(s => s.Id == id, cancellationToken);
        if (row is null) return;
        ctx.Scenarios.Remove(row);
        await ctx.SaveChangesAsync(cancellationToken);
    }
}
