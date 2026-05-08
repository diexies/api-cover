using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;

namespace APICover.Agent.Memory;

internal sealed class FilesystemAgentMemoryStore : IAgentMemoryStore
{
    private readonly string _root;
    private readonly int _maxBytes;

    public FilesystemAgentMemoryStore(IOptions<AgentOptions> options, IHostEnvironment env)
    {
        var raw = options.Value.MemoryRoot;
        var resolved = string.IsNullOrEmpty(raw)
            ? Path.Combine(env.ContentRootPath, "docs", "apicover-agent")
            : (Path.IsPathRooted(raw) ? raw : Path.Combine(env.ContentRootPath, raw));
        _root = Path.GetFullPath(resolved);
        _maxBytes = options.Value.MaxMemoryFileBytes;
        Directory.CreateDirectory(_root);
    }

    public string RootPath => _root;

    public async Task<string?> ReadAsync(string relativePath, CancellationToken cancellationToken = default)
    {
        var abs = MemoryPathSandbox.ResolveAbsolute(_root, relativePath);
        if (!File.Exists(abs)) return null;
        return await File.ReadAllTextAsync(abs, cancellationToken);
    }

    public Task<IReadOnlyList<MemoryEntry>> ListAsync(string? prefix = null, CancellationToken cancellationToken = default)
    {
        if (!Directory.Exists(_root))
        {
            return Task.FromResult<IReadOnlyList<MemoryEntry>>(Array.Empty<MemoryEntry>());
        }
        var entries = new List<MemoryEntry>();
        foreach (var file in Directory.EnumerateFiles(_root, "*.md", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(_root, file).Replace('\\', '/').ToLowerInvariant();
            if (!string.IsNullOrEmpty(prefix) && !rel.StartsWith(prefix, StringComparison.Ordinal)) continue;
            var info = new FileInfo(file);
            entries.Add(new MemoryEntry(rel, info.Length, info.LastWriteTimeUtc));
        }
        entries.Sort((a, b) => string.CompareOrdinal(a.Path, b.Path));
        return Task.FromResult<IReadOnlyList<MemoryEntry>>(entries);
    }

    public async Task WriteAsync(string relativePath, string content, CancellationToken cancellationToken = default)
    {
        var abs = MemoryPathSandbox.ResolveAbsolute(_root, relativePath);
        EnforceSize(content);
        var dir = Path.GetDirectoryName(abs);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        await File.WriteAllTextAsync(abs, content, cancellationToken);
    }

    public async Task AppendAsync(string relativePath, string content, CancellationToken cancellationToken = default)
    {
        var abs = MemoryPathSandbox.ResolveAbsolute(_root, relativePath);
        var dir = Path.GetDirectoryName(abs);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        if (File.Exists(abs))
        {
            var existing = await File.ReadAllTextAsync(abs, cancellationToken);
            EnforceSize(existing + content);
            await File.AppendAllTextAsync(abs, content, cancellationToken);
        }
        else
        {
            EnforceSize(content);
            await File.WriteAllTextAsync(abs, content, cancellationToken);
        }
    }

    public Task DeleteAsync(string relativePath, CancellationToken cancellationToken = default)
    {
        var abs = MemoryPathSandbox.ResolveAbsolute(_root, relativePath);
        if (File.Exists(abs)) File.Delete(abs);
        return Task.CompletedTask;
    }

    public Task<bool> AnyAsync(CancellationToken cancellationToken = default)
    {
        if (!Directory.Exists(_root)) return Task.FromResult(false);
        return Task.FromResult(Directory.EnumerateFiles(_root, "*.md", SearchOption.AllDirectories).Any());
    }

    private void EnforceSize(string content)
    {
        var bytes = System.Text.Encoding.UTF8.GetByteCount(content);
        if (bytes > _maxBytes)
        {
            throw new InvalidOperationException(
                $"Memory file exceeds {_maxBytes} bytes (got {bytes}). Split into multiple files.");
        }
    }
}
