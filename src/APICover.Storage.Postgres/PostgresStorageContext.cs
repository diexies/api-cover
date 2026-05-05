using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using APICover.Abstractions.Models;

namespace APICover.Storage.Postgres;

/// <summary>
/// EF Core <see cref="DbContext"/> for the Postgres storage provider. Scenarios and runs
/// are stored as <c>jsonb</c> blobs alongside a few denormalised columns (id, scenario id,
/// timestamps) used for indexing and listing — avoiding column-per-property mapping while
/// the domain models still evolve.
/// </summary>
public sealed class PostgresStorageContext : DbContext
{
    public PostgresStorageContext(DbContextOptions<PostgresStorageContext> options) : base(options) { }

    public DbSet<ScenarioRow> Scenarios => Set<ScenarioRow>();
    public DbSet<RunRow> Runs => Set<RunRow>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        var scenario = modelBuilder.Entity<ScenarioRow>();
        scenario.ToTable("apicover_scenarios");
        scenario.HasKey(s => s.Id);
        scenario.Property(s => s.Id).HasColumnName("id").HasMaxLength(200);
        scenario.Property(s => s.Name).HasColumnName("name").HasMaxLength(500);
        scenario.Property(s => s.UpdatedAt).HasColumnName("updated_at");
        scenario.Property(s => s.Document).HasColumnName("document").HasColumnType("jsonb");
        scenario.HasIndex(s => s.UpdatedAt);

        var run = modelBuilder.Entity<RunRow>();
        run.ToTable("apicover_runs");
        run.HasKey(r => r.Id);
        run.Property(r => r.Id).HasColumnName("id").HasMaxLength(64);
        run.Property(r => r.ScenarioId).HasColumnName("scenario_id").HasMaxLength(200);
        run.Property(r => r.StartedAt).HasColumnName("started_at");
        run.Property(r => r.Document).HasColumnName("document").HasColumnType("jsonb");
        run.HasIndex(r => r.ScenarioId);
        run.HasIndex(r => r.StartedAt);
    }
}

/// <summary>Persistence row for <see cref="Scenario"/>: indexable columns + jsonb blob.</summary>
public sealed class ScenarioRow
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public DateTimeOffset UpdatedAt { get; set; }
    public string Document { get; set; } = "{}";

    public Scenario ToScenario(JsonSerializerOptions options) =>
        JsonSerializer.Deserialize<Scenario>(Document, options)
        ?? throw new InvalidOperationException($"Scenario {Id} document is empty.");

    public static ScenarioRow FromScenario(Scenario scenario, JsonSerializerOptions options) => new()
    {
        Id = scenario.Id,
        Name = scenario.Name,
        UpdatedAt = scenario.UpdatedAt,
        Document = JsonSerializer.Serialize(scenario, options)
    };
}

/// <summary>Persistence row for <see cref="Run"/>: indexable columns + jsonb blob.</summary>
public sealed class RunRow
{
    public string Id { get; set; } = string.Empty;
    public string ScenarioId { get; set; } = string.Empty;
    public DateTimeOffset StartedAt { get; set; }
    public string Document { get; set; } = "{}";

    public Run ToRun(JsonSerializerOptions options) =>
        JsonSerializer.Deserialize<Run>(Document, options)
        ?? throw new InvalidOperationException($"Run {Id} document is empty.");

    public static RunRow FromRun(Run run, JsonSerializerOptions options) => new()
    {
        Id = run.Id,
        ScenarioId = run.ScenarioId,
        StartedAt = run.StartedAt,
        Document = JsonSerializer.Serialize(run, options)
    };
}
