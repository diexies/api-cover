using System.Collections.Concurrent;
using Microsoft.AspNetCore.Http;

namespace APICover.Mcp.Hosting;

/// <summary>
/// Tracks IDE clients that have hit the MCP transport recently. Keyed by Mcp-Session-Id
/// when present (modern spec) with a UA+IP fallback for older clients. Entries older
/// than <see cref="Ttl"/> are filtered out by <see cref="Snapshot"/>; a hard cap with
/// LRU eviction prevents the dictionary growing unbounded.
/// </summary>
internal sealed class LiveMcpConnectionRegistry
{
    private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(10);
    private const int HardCap = 256;

    private readonly ConcurrentDictionary<string, LiveConnection> _entries = new(StringComparer.Ordinal);

    public void Record(HttpContext ctx)
    {
        var sessionId = ctx.Request.Headers["Mcp-Session-Id"].ToString();
        var ua = ctx.Request.Headers.UserAgent.ToString();
        var ip = ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        var clientId = !string.IsNullOrWhiteSpace(sessionId)
            ? sessionId
            : $"{(string.IsNullOrEmpty(ua) ? "anon" : ua)}|{ip}";

        var now = DateTimeOffset.UtcNow;
        _entries.AddOrUpdate(
            clientId,
            _ => new LiveConnection(clientId, string.IsNullOrEmpty(ua) ? null : ua, ip, now, now, 1),
            (_, existing) => existing with { LastSeen = now, RequestCount = existing.RequestCount + 1 });

        if (_entries.Count > HardCap)
        {
            var oldest = _entries
                .OrderBy(kv => kv.Value.LastSeen)
                .Take(_entries.Count - HardCap)
                .Select(kv => kv.Key)
                .ToArray();
            foreach (var k in oldest) _entries.TryRemove(k, out _);
        }
    }

    /// <summary>Returns entries seen within <see cref="Ttl"/>, most-recent first.</summary>
    public IReadOnlyList<LiveConnection> Snapshot()
    {
        var cutoff = DateTimeOffset.UtcNow - Ttl;
        return _entries.Values
            .Where(v => v.LastSeen >= cutoff)
            .OrderByDescending(v => v.LastSeen)
            .ToArray();
    }
}
