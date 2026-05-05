using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;
using APICover.Abstractions.Models;
using APICover.Abstractions.Services;

namespace APICover.Storage.Postgres;

/// <summary>EF Core / Npgsql backed <see cref="IRunStore"/>. Run JSON lives in a <c>jsonb</c>
/// column; <c>scenario_id</c> + <c>started_at</c> are indexed for filter+order listings.</summary>
public sealed class PostgresRunStore : IRunStore
{
    private readonly IDbContextFactory<PostgresStorageContext> _ctxFactory;
    private readonly JsonSerializerOptions _json;

    public PostgresRunStore(IDbContextFactory<PostgresStorageContext> ctxFactory)
    {
        _ctxFactory = ctxFactory;
        _json = new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) }
        };
    }

    public async Task<IReadOnlyList<Run>> ListAsync(string? scenarioId = null, int take = 50, CancellationToken cancellationToken = default)
    {
        await using var ctx = await _ctxFactory.CreateDbContextAsync(cancellationToken);
        var query = ctx.Runs.AsNoTracking();
        if (scenarioId is not null) query = query.Where(r => r.ScenarioId == scenarioId);
        var rows = await query.OrderByDescending(r => r.StartedAt).Take(take).ToListAsync(cancellationToken);
        return rows.Select(r => r.ToRun(_json)).ToList();
    }

    public async Task<Run?> GetAsync(string id, CancellationToken cancellationToken = default)
    {
        await using var ctx = await _ctxFactory.CreateDbContextAsync(cancellationToken);
        var row = await ctx.Runs.AsNoTracking().FirstOrDefaultAsync(r => r.Id == id, cancellationToken);
        return row?.ToRun(_json);
    }

    public async Task SaveAsync(Run run, CancellationToken cancellationToken = default)
    {
        await using var ctx = await _ctxFactory.CreateDbContextAsync(cancellationToken);
        var row = RunRow.FromRun(run, _json);
        var existing = await ctx.Runs.FirstOrDefaultAsync(r => r.Id == run.Id, cancellationToken);
        if (existing is null)
        {
            ctx.Runs.Add(row);
        }
        else
        {
            existing.ScenarioId = row.ScenarioId;
            existing.StartedAt = row.StartedAt;
            existing.Document = row.Document;
        }
        await ctx.SaveChangesAsync(cancellationToken);
    }

    public async Task DeleteAsync(string id, CancellationToken cancellationToken = default)
    {
        await using var ctx = await _ctxFactory.CreateDbContextAsync(cancellationToken);
        var row = await ctx.Runs.FirstOrDefaultAsync(r => r.Id == id, cancellationToken);
        if (row is null) return;
        ctx.Runs.Remove(row);
        await ctx.SaveChangesAsync(cancellationToken);
    }
}
