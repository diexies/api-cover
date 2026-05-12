using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using APICover.Abstractions.Models;
using APICover.Abstractions.Services;

namespace APICover.Storage;

/// <summary>
/// Per-scenario persistent history of the last N terminal runs. Decorates the registered
/// <see cref="IRunStore"/>: every <see cref="SaveAsync"/> call is forwarded to the inner
/// store; whenever the run reaches a terminal status it is also written to
/// <c>{ContentRoot}/docs/apicover-history/{scenarioId}/history/rN.json</c>, oldest pruned
/// when the directory exceeds <see cref="HistoryCap"/>. List/Get fall back to the disk
/// history when the inner store has no record (e.g. after process restart with
/// InMemoryRunStore).
/// </summary>
public sealed class FilesystemRunHistoryStore : IRunStore
{
    public const int HistoryCap = 10;

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private readonly IRunStore _inner;
    private readonly string _root;
    private readonly ILogger<FilesystemRunHistoryStore>? _log;

    public FilesystemRunHistoryStore(IRunStore inner, IHostEnvironment env, IOptions<APICoverOptions>? options = null, ILogger<FilesystemRunHistoryStore>? log = null)
    {
        _inner = inner;
        _log = log;
        var configured = options?.Value?.RunHistoryRoot;
        _root = string.IsNullOrWhiteSpace(configured)
            ? Path.Combine(env.ContentRootPath, "docs", "apicover-history")
            : configured!;
    }

    public string Root => _root;

    public Task<IReadOnlyList<Run>> ListAsync(string? scenarioId = null, int take = 50, CancellationToken cancellationToken = default)
        => _inner.ListAsync(scenarioId, take, cancellationToken);

    public Task<Run?> GetAsync(string id, CancellationToken cancellationToken = default)
        => _inner.GetAsync(id, cancellationToken);

    public async Task SaveAsync(Run run, CancellationToken cancellationToken = default)
    {
        await _inner.SaveAsync(run, cancellationToken).ConfigureAwait(false);
        if (run.Status is RunStatus.Succeeded or RunStatus.Failed or RunStatus.Cancelled)
        {
            try { await WriteHistoryAsync(run, cancellationToken).ConfigureAwait(false); }
            catch (Exception ex) { _log?.LogWarning(ex, "Failed to persist run history for {RunId}", run.Id); }
        }
    }

    public Task DeleteAsync(string id, CancellationToken cancellationToken = default)
        => _inner.DeleteAsync(id, cancellationToken);

    /// <summary>List recent persisted runs for a scenario, newest first. Reads from disk.</summary>
    public IReadOnlyList<Run> ListHistory(string scenarioId)
    {
        var dir = Path.Combine(_root, SafeId(scenarioId), "history");
        if (!Directory.Exists(dir)) return Array.Empty<Run>();
        var files = Directory.GetFiles(dir, "r*.json")
            .OrderByDescending(p => File.GetLastWriteTimeUtc(p));
        var list = new List<Run>();
        foreach (var f in files)
        {
            try
            {
                using var fs = File.OpenRead(f);
                var run = JsonSerializer.Deserialize<Run>(fs, JsonOptions);
                if (run is not null) list.Add(run);
            }
            catch { /* skip corrupt entry */ }
        }
        return list;
    }

    /// <summary>Delete the entire history directory for a scenario. Called when the scenario is deleted.</summary>
    public void DeleteHistory(string scenarioId)
    {
        var dir = Path.Combine(_root, SafeId(scenarioId));
        if (Directory.Exists(dir))
        {
            try { Directory.Delete(dir, recursive: true); } catch (Exception ex) { _log?.LogWarning(ex, "Failed to delete history dir {Dir}", dir); }
        }
    }

    private async Task WriteHistoryAsync(Run run, CancellationToken ct)
    {
        var dir = Path.Combine(_root, SafeId(run.ScenarioId), "history");
        Directory.CreateDirectory(dir);

        // Determine the next rN slot. We use sequential numeric suffixes so the file name
        // tells the user the chronological position at a glance ("r10.json is the newest").
        var existing = Directory.GetFiles(dir, "r*.json")
            .OrderBy(p => File.GetLastWriteTimeUtc(p))
            .ToList();

        // Prune oldest beyond cap-1 so the new write keeps total at HistoryCap.
        while (existing.Count >= HistoryCap)
        {
            try { File.Delete(existing[0]); } catch { /* race / readonly */ }
            existing.RemoveAt(0);
        }

        // Pick the next index: max(existing index) + 1, but wrap back to r1 once we've
        // pruned old entries — keep file names compact (never rN where N > HistoryCap*2).
        var nextIdx = 1;
        if (existing.Count > 0)
        {
            var indices = existing
                .Select(p => Path.GetFileNameWithoutExtension(p))
                .Where(n => n.StartsWith('r'))
                .Select(n => int.TryParse(n.AsSpan(1), out var i) ? i : 0)
                .Where(i => i > 0)
                .ToList();
            if (indices.Count > 0)
            {
                nextIdx = indices.Max() + 1;
                if (nextIdx > HistoryCap * 2)
                {
                    // Renumber: re-slot existing files r1..rN sequentially, then write new as rN+1.
                    var renamed = 0;
                    foreach (var path in existing.OrderBy(p => File.GetLastWriteTimeUtc(p)))
                    {
                        var target = Path.Combine(dir, $"r{++renamed}.json");
                        if (path != target)
                        {
                            try { File.Move(path, target, overwrite: true); } catch { /* race */ }
                        }
                    }
                    nextIdx = renamed + 1;
                }
            }
        }

        var file = Path.Combine(dir, $"r{nextIdx}.json");
        await using var fs = File.Create(file);
        await JsonSerializer.SerializeAsync(fs, run, JsonOptions, ct).ConfigureAwait(false);
    }

    private static string SafeId(string id) =>
        string.IsNullOrWhiteSpace(id) ? "_" : new string(id.Select(c =>
            char.IsLetterOrDigit(c) || c is '-' or '_' ? c : '_').ToArray());
}
