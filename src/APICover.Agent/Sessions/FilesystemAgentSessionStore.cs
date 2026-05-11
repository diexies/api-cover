using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;

namespace APICover.Agent.Sessions;

internal sealed class FilesystemAgentSessionStore : IAgentSessionStore
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        // PascalCase enum strings keep session JSON aligned with SSE event names
        // and the UI's eventDisplay map. The frontend still tolerates legacy
        // camelCase types so existing sessions replay correctly.
        Converters = { new JsonStringEnumConverter() }
    };

    private readonly string _root;

    public FilesystemAgentSessionStore(IOptions<AgentOptions> options, IHostEnvironment env)
    {
        var raw = options.Value.SessionsRoot;
        var resolved = string.IsNullOrEmpty(raw)
            ? Path.Combine(env.ContentRootPath, "docs", "apicover-agent-sessions")
            : (Path.IsPathRooted(raw) ? raw : Path.Combine(env.ContentRootPath, raw));
        _root = Path.GetFullPath(resolved);
        Directory.CreateDirectory(_root);
    }

    public string RootPath => _root;

    public async Task SaveAsync(SessionDoc session, CancellationToken cancellationToken = default)
    {
        ValidateId(session.Id);
        var path = ResolvePath(session.Id, session.StartedAt);
        var dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

        // Snapshot the event list before serialising so concurrent appends from the
        // coordinator's writer task can't trip the JSON enumerator.
        var snapshot = new SessionDoc
        {
            Id = session.Id,
            Prompt = session.Prompt,
            Mode = session.Mode,
            StartedAt = session.StartedAt,
            CompletedAt = session.CompletedAt,
            Status = session.Status,
            Model = session.Model,
            Totals = session.Totals,
            Error = session.Error
        };
        lock (session.Events)
        {
            snapshot.Events.AddRange(session.Events);
        }

        var tmp = path + ".tmp";
        await using (var stream = File.Create(tmp))
        {
            await JsonSerializer.SerializeAsync(stream, snapshot, Json, cancellationToken);
        }
        File.Move(tmp, path, overwrite: true);
    }

    public async Task<SessionDoc?> GetAsync(string id, CancellationToken cancellationToken = default)
    {
        ValidateId(id);
        var hit = FindFileById(id);
        if (hit is null) return null;
        await using var stream = File.OpenRead(hit);
        return await JsonSerializer.DeserializeAsync<SessionDoc>(stream, Json, cancellationToken);
    }

    public async Task<IReadOnlyList<SessionSummary>> ListAsync(int take = 50, CancellationToken cancellationToken = default)
    {
        if (!Directory.Exists(_root)) return Array.Empty<SessionSummary>();

        var files = Directory
            .EnumerateFiles(_root, "*.json", SearchOption.AllDirectories)
            .OrderByDescending(File.GetLastWriteTimeUtc)
            .Take(take)
            .ToList();

        var result = new List<SessionSummary>(files.Count);
        foreach (var file in files)
        {
            try
            {
                await using var stream = File.OpenRead(file);
                var doc = await JsonSerializer.DeserializeAsync<SessionDoc>(stream, Json, cancellationToken);
                if (doc is null) continue;
                result.Add(new SessionSummary(
                    doc.Id, doc.Prompt, doc.Mode, doc.StartedAt, doc.CompletedAt,
                    doc.Status, doc.Totals));
            }
            catch (JsonException) { /* skip corrupted file */ }
        }
        return result;
    }

    public Task DeleteAsync(string id, CancellationToken cancellationToken = default)
    {
        ValidateId(id);
        var hit = FindFileById(id);
        if (hit is not null) File.Delete(hit);
        return Task.CompletedTask;
    }

    private string ResolvePath(string id, DateTimeOffset startedAt)
        => Path.Combine(_root, startedAt.UtcDateTime.ToString("yyyy-MM-dd"), id + ".json");

    private string? FindFileById(string id)
    {
        if (!Directory.Exists(_root)) return null;
        return Directory.EnumerateFiles(_root, id + ".json", SearchOption.AllDirectories)
            .FirstOrDefault();
    }

    private static void ValidateId(string id)
    {
        if (string.IsNullOrEmpty(id))
            throw new ArgumentException("Session id must not be empty.", nameof(id));
        foreach (var c in id)
        {
            if (!char.IsAsciiLetterOrDigit(c) && c != '-')
                throw new ArgumentException(
                    $"Session id contains invalid character '{c}'. Allowed: a-z A-Z 0-9 -",
                    nameof(id));
        }
    }
}
