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
/// Disk-backed custom tool store. Persists each definition as
/// <c>{ContentRoot}/docs/apicover-custom-tools/{name}.json</c> so the catalogue survives process
/// restarts. Reads are served from an in-memory cache hydrated on first access; writes
/// fan out to both cache and disk.
/// </summary>
public sealed class FilesystemCustomToolStore : ICustomToolStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private readonly string _root;
    private readonly ILogger<FilesystemCustomToolStore>? _log;
    private readonly ConcurrentDictionary<string, CustomToolDefinition> _cache = new(StringComparer.Ordinal);
    private bool _hydrated;
    private readonly object _hydrateLock = new();

    public FilesystemCustomToolStore(IHostEnvironment env, IOptions<APICoverOptions>? options = null, ILogger<FilesystemCustomToolStore>? log = null)
    {
        _log = log;
        var configured = options?.Value?.CustomToolRoot;
        _root = string.IsNullOrWhiteSpace(configured)
            ? Path.Combine(env.ContentRootPath, "docs", "apicover-custom-tools")
            : configured!;
        Directory.CreateDirectory(_root);
    }

    public string Root => _root;

    public Task<IReadOnlyList<CustomToolDefinition>> ListAsync(CancellationToken cancellationToken = default)
    {
        Hydrate();
        IReadOnlyList<CustomToolDefinition> snap = _cache.Values
            .OrderBy(t => t.Name, StringComparer.Ordinal)
            .ToArray();
        return Task.FromResult(snap);
    }

    public Task<CustomToolDefinition?> GetAsync(string name, CancellationToken cancellationToken = default)
    {
        Hydrate();
        _cache.TryGetValue(name, out var def);
        return Task.FromResult(def);
    }

    public async Task SaveAsync(CustomToolDefinition definition, CancellationToken cancellationToken = default)
    {
        Hydrate();
        var now = DateTimeOffset.UtcNow;
        if (definition.CreatedAt == default) definition.CreatedAt = now;
        definition.UpdatedAt = now;
        _cache[definition.Name] = definition;
        var path = PathFor(definition.Name);
        await using var fs = File.Create(path);
        await JsonSerializer.SerializeAsync(fs, definition, JsonOptions, cancellationToken).ConfigureAwait(false);
    }

    public Task DeleteAsync(string name, CancellationToken cancellationToken = default)
    {
        Hydrate();
        _cache.TryRemove(name, out _);
        var path = PathFor(name);
        if (File.Exists(path))
        {
            try { File.Delete(path); } catch (Exception ex) { _log?.LogWarning(ex, "Failed to delete custom tool file {Path}", path); }
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
                        var def = JsonSerializer.Deserialize<CustomToolDefinition>(fs, JsonOptions);
                        if (def is not null && !string.IsNullOrWhiteSpace(def.Name))
                        {
                            _cache[def.Name] = def;
                        }
                    }
                    catch (Exception ex)
                    {
                        _log?.LogWarning(ex, "Skipping corrupt custom tool file {Path}", file);
                    }
                }
            }
            finally
            {
                _hydrated = true;
            }
        }
    }

    private string PathFor(string name)
    {
        var safe = new string(name.Select(c => char.IsLetterOrDigit(c) || c is '-' or '_' or '.' ? c : '_').ToArray());
        return Path.Combine(_root, $"{safe}.json");
    }
}
