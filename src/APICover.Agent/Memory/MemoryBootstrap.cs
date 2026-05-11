using System.Reflection;

namespace APICover.Agent.Memory;

/// <summary>
/// Copies the embedded INTRODUCE.md to the memory root on first boot if absent.
/// Re-runs are idempotent — never overwrites a human-edited copy.
/// </summary>
public sealed class MemoryBootstrap
{
    private const string EmbeddedResource = "APICover.Agent.Resources.INTRODUCE.md";
    private const string TargetPath = "introduce.md";
    private readonly IAgentMemoryStore _store;

    public MemoryBootstrap(IAgentMemoryStore store) { _store = store; }

    public async Task EnsureAsync(CancellationToken cancellationToken = default)
    {
        var existing = await _store.ReadAsync(TargetPath, cancellationToken);
        if (existing is not null) return;

        var asm = typeof(MemoryBootstrap).Assembly;
        await using var stream = asm.GetManifestResourceStream(EmbeddedResource)
            ?? throw new InvalidOperationException(
                $"Embedded resource '{EmbeddedResource}' not found. Build configuration broken.");
        using var reader = new StreamReader(stream);
        var content = await reader.ReadToEndAsync(cancellationToken);
        await _store.WriteAsync(TargetPath, content, cancellationToken);
    }

    public async Task<string> GetIntroduceAsync(CancellationToken cancellationToken = default)
    {
        await EnsureAsync(cancellationToken);
        return await _store.ReadAsync(TargetPath, cancellationToken)
            ?? throw new InvalidOperationException("INTRODUCE.md missing after bootstrap.");
    }

    /// <summary>Build a compact INDEX representation for system-prompt injection. Falls
    /// back to a generated header when no INDEX.md exists yet.</summary>
    public async Task<string> GetIndexSnapshotAsync(CancellationToken cancellationToken = default)
    {
        var explicitIndex = await _store.ReadAsync("index.md", cancellationToken);
        if (explicitIndex is not null) return explicitIndex;

        var entries = await _store.ListAsync(cancellationToken: cancellationToken);
        if (entries.Count == 0)
        {
            return "# Memory Index\n\n(empty — run `scan` mode to populate)\n";
        }
        var lines = new List<string> { "# Memory Index", string.Empty, "## Files", string.Empty };
        foreach (var e in entries)
        {
            if (e.Path is "index.md" or "introduce.md") continue;
            lines.Add($"- [{e.Path}]({e.Path}) — {e.Bytes} bytes");
        }
        return string.Join('\n', lines);
    }
}
