using System.ComponentModel;
using ModelContextProtocol.Server;
using APICover.Agent.Memory;

namespace APICover.Mcp.Tools;

/// <summary>
/// Memory tools mirror <see cref="APICover.Agent.Tools.ToolDispatcher"/>'s memory
/// handlers. Available only when the host has called <c>AddAPICoverAgent()</c> —
/// without it, <see cref="IAgentMemoryStore"/> isn't bound and the SDK throws on
/// per-call resolution. That's the right behaviour: surface a clear "agent not
/// installed" error instead of fabricating a no-op.
/// </summary>
[McpServerToolType]
public static class MemoryTools
{
    [McpServerTool(Name = "memory.list")]
    [Description("WHEN: discovering captured knowledge before answering or writing.\n\nList memory files. Optional path prefix filter.")]
    public static async Task<object> List(
        IAgentMemoryStore store,
        [Description("Optional path prefix filter (e.g. \"endpoints/\").")] string? prefix = null,
        CancellationToken ct = default)
    {
        var entries = await store.ListAsync(prefix, ct);
        return new
        {
            root = store.RootPath,
            count = entries.Count,
            files = entries.Select(e => new
            {
                path = e.Path,
                bytes = e.Bytes,
                updatedAt = e.UpdatedAt,
            }).ToArray(),
        };
    }

    [McpServerTool(Name = "memory.read")]
    [Description("WHEN: need the body of a specific memory file after memory.list shows it exists.\n\nRead the full content of a memory file. Returns { found: bool, content?: string }.")]
    public static async Task<object> Read(
        IAgentMemoryStore store,
        [Description("Relative path under the memory root, e.g. \"endpoints/users.md\".")] string path,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            throw new ArgumentException("Required field 'path' is missing.", nameof(path));
        }
        var content = await store.ReadAsync(path, ct);
        return content is null
            ? new { found = false, path }
            : (object)new { found = true, path, content };
    }

    [McpServerTool(Name = "memory.write")]
    [Description("WHEN: persisting a new piece of stable knowledge worth recalling in future sessions.\n\nCreate or replace a memory file (markdown only — paths must end with .md).")]
    public static async Task<object> Write(
        IAgentMemoryStore store,
        [Description("Relative path under the memory root.")] string path,
        [Description("UTF-8 file content.")] string content,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            throw new ArgumentException("Required field 'path' is missing.", nameof(path));
        }
        await store.WriteAsync(path, content, ct);
        return new { ok = true, path, bytes = System.Text.Encoding.UTF8.GetByteCount(content) };
    }

    [McpServerTool(Name = "memory.append")]
    [Description("WHEN: extending an existing memory file with a new section/log entry instead of overwriting.\n\nAppend content to an existing memory file (creates if absent).")]
    public static async Task<object> Append(
        IAgentMemoryStore store,
        [Description("Relative path under the memory root.")] string path,
        [Description("UTF-8 content to append.")] string content,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            throw new ArgumentException("Required field 'path' is missing.", nameof(path));
        }
        await store.AppendAsync(path, content, ct);
        return new { ok = true, path };
    }

    [McpServerTool(Name = "memory.delete")]
    [Description("WHEN: user asks to forget something, or removing outdated/incorrect memory.\n\nDelete a memory file by path.")]
    public static async Task<object> Delete(
        IAgentMemoryStore store,
        [Description("Relative path under the memory root.")] string path,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            throw new ArgumentException("Required field 'path' is missing.", nameof(path));
        }
        await store.DeleteAsync(path, ct);
        return new { ok = true, path };
    }
}
