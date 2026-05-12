using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using APICover.Abstractions.Models;
using APICover.Abstractions.Services;

namespace APICover.Storage;

/// <summary>
/// Disk-backed scenario store. Persists each scenario as
/// <c>{ContentRoot}/docs/apicover-scenarios/{id}.json</c> so the workspace survives process
/// restarts. Reads are served from an in-memory cache hydrated on first access; writes
/// fan out to both cache and disk.
/// </summary>
public sealed class FilesystemScenarioStore : IScenarioStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private readonly string _root;
    private readonly ILogger<FilesystemScenarioStore>? _log;
    private readonly ConcurrentDictionary<string, Scenario> _cache = new(StringComparer.Ordinal);
    private bool _hydrated;
    private readonly object _hydrateLock = new();

    public FilesystemScenarioStore(IHostEnvironment env, IOptions<APICoverOptions>? options = null, ILogger<FilesystemScenarioStore>? log = null)
    {
        _log = log;
        var configured = options?.Value?.ScenarioRoot;
        _root = string.IsNullOrWhiteSpace(configured)
            ? Path.Combine(env.ContentRootPath, "docs", "apicover-scenarios")
            : configured!;
        Directory.CreateDirectory(_root);
    }

    public string Root => _root;

    public Task<IReadOnlyList<Scenario>> ListAsync(CancellationToken cancellationToken = default)
    {
        Hydrate();
        IReadOnlyList<Scenario> snap = _cache.Values
            .OrderBy(s => s.Id, StringComparer.Ordinal)
            .ToArray();
        return Task.FromResult(snap);
    }

    public Task<Scenario?> GetAsync(string id, CancellationToken cancellationToken = default)
    {
        Hydrate();
        _cache.TryGetValue(id, out var s);
        return Task.FromResult(s);
    }

    public async Task SaveAsync(Scenario scenario, CancellationToken cancellationToken = default)
    {
        Hydrate();
        scenario.UpdatedAt = DateTimeOffset.UtcNow;
        _cache[scenario.Id] = scenario;
        var path = PathFor(scenario.Id);
        await using var fs = File.Create(path);
        await JsonSerializer.SerializeAsync(fs, scenario, JsonOptions, cancellationToken).ConfigureAwait(false);
    }

    public Task DeleteAsync(string id, CancellationToken cancellationToken = default)
    {
        Hydrate();
        _cache.TryRemove(id, out _);
        var path = PathFor(id);
        if (File.Exists(path))
        {
            try { File.Delete(path); } catch (Exception ex) { _log?.LogWarning(ex, "Failed to delete scenario file {Path}", path); }
        }
        return Task.CompletedTask;
    }

    private void Hydrate()
    {
        if (_hydrated) return;
        lock (_hydrateLock)
        {
            if (_hydrated) return;
            try
            {
                foreach (var file in Directory.EnumerateFiles(_root, "*.json"))
                {
                    try
                    {
                        using var fs = File.OpenRead(file);
                        var s = JsonSerializer.Deserialize<Scenario>(fs, JsonOptions);
                        if (s is not null && !string.IsNullOrWhiteSpace(s.Id))
                        {
                            _cache[s.Id] = s;
                        }
                    }
                    catch (Exception ex)
                    {
                        _log?.LogWarning(ex, "Skipping corrupt scenario file {Path}", file);
                    }
                }
            }
            finally
            {
                _hydrated = true;
            }
        }
    }

    private string PathFor(string id)
    {
        var safe = new string(id.Select(c => char.IsLetterOrDigit(c) || c is '-' or '_' ? c : '_').ToArray());
        return Path.Combine(_root, $"{safe}.json");
    }
}
