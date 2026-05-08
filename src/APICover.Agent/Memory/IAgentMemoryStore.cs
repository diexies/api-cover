namespace APICover.Agent.Memory;

/// <summary>
/// Persistent file-backed memory the agent reads and writes during its work. Default
/// implementation roots at <c>{ContentRoot}/docs/apicover-agent</c>; the directory ships
/// with the host project's git history so memory survives redeployments.
/// </summary>
public interface IAgentMemoryStore
{
    /// <summary>Absolute filesystem root, for diagnostics + UI display.</summary>
    string RootPath { get; }

    /// <summary>Read a file by relative path under root. Returns null when missing.</summary>
    Task<string?> ReadAsync(string relativePath, CancellationToken cancellationToken = default);

    /// <summary>List every memory file under <paramref name="prefix"/> (or the entire tree).
    /// Sorted by path, ascending.</summary>
    Task<IReadOnlyList<MemoryEntry>> ListAsync(string? prefix = null, CancellationToken cancellationToken = default);

    /// <summary>Replace (or create) a file. Parent directories created as needed.</summary>
    Task WriteAsync(string relativePath, string content, CancellationToken cancellationToken = default);

    /// <summary>Append to an existing file (creates with content if missing).</summary>
    Task AppendAsync(string relativePath, string content, CancellationToken cancellationToken = default);

    /// <summary>Delete a file. No-op when already absent.</summary>
    Task DeleteAsync(string relativePath, CancellationToken cancellationToken = default);

    /// <summary>True iff at least one memory file exists. Drives "scan project" CTA in UI.</summary>
    Task<bool> AnyAsync(CancellationToken cancellationToken = default);
}

public sealed record MemoryEntry(string Path, long Bytes, DateTimeOffset UpdatedAt);
