using System.Collections.Concurrent;

namespace APICover.Agent.Memory;

/// <summary>Test-only ephemeral memory store. Same path validation rules.</summary>
public sealed class InMemoryAgentMemoryStore : IAgentMemoryStore
{
    private readonly ConcurrentDictionary<string, (string Content, DateTimeOffset At)> _files = new();

    public string RootPath => "(in-memory)";

    public Task<string?> ReadAsync(string relativePath, CancellationToken cancellationToken = default)
    {
        var key = MemoryPathSandbox.Normalise(relativePath);
        return Task.FromResult(_files.TryGetValue(key, out var v) ? v.Content : null);
    }

    public Task<IReadOnlyList<MemoryEntry>> ListAsync(string? prefix = null, CancellationToken cancellationToken = default)
    {
        IEnumerable<KeyValuePair<string, (string Content, DateTimeOffset At)>> q = _files;
        if (!string.IsNullOrEmpty(prefix))
        {
            q = q.Where(kv => kv.Key.StartsWith(prefix, StringComparison.Ordinal));
        }
        var list = q
            .OrderBy(kv => kv.Key, StringComparer.Ordinal)
            .Select(kv => new MemoryEntry(kv.Key, System.Text.Encoding.UTF8.GetByteCount(kv.Value.Content), kv.Value.At))
            .ToList();
        return Task.FromResult<IReadOnlyList<MemoryEntry>>(list);
    }

    public Task WriteAsync(string relativePath, string content, CancellationToken cancellationToken = default)
    {
        var key = MemoryPathSandbox.Normalise(relativePath);
        _files[key] = (content, DateTimeOffset.UtcNow);
        return Task.CompletedTask;
    }

    public Task AppendAsync(string relativePath, string content, CancellationToken cancellationToken = default)
    {
        var key = MemoryPathSandbox.Normalise(relativePath);
        _files.AddOrUpdate(
            key,
            _ => (content, DateTimeOffset.UtcNow),
            (_, prev) => (prev.Content + content, DateTimeOffset.UtcNow));
        return Task.CompletedTask;
    }

    public Task DeleteAsync(string relativePath, CancellationToken cancellationToken = default)
    {
        var key = MemoryPathSandbox.Normalise(relativePath);
        _files.TryRemove(key, out _);
        return Task.CompletedTask;
    }

    public Task<bool> AnyAsync(CancellationToken cancellationToken = default)
        => Task.FromResult(_files.Count > 0);
}
