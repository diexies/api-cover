using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;

namespace APICover.Agent.Credentials;

/// <summary>
/// Persists the workspace credential selection (mode + encrypted API key) to disk so the
/// user's choice survives a host restart. EncryptedApiKey is opaque ciphertext via Data
/// Protection — plaintext never crosses this boundary.
/// </summary>
internal sealed class FilesystemAgentCredentialStore : IAgentCredentialStore
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) }
    };

    private readonly string _path;
    private readonly object _lock = new();
    private StoredCredential? _cached;
    private bool _loaded;

    public FilesystemAgentCredentialStore(IOptions<AgentOptions> options, IHostEnvironment env)
    {
        var raw = options.Value.CredentialsPath;
        var resolved = string.IsNullOrEmpty(raw)
            ? Path.Combine(env.ContentRootPath, "docs", "apicover-agent", "credentials.json")
            : (Path.IsPathRooted(raw) ? raw : Path.Combine(env.ContentRootPath, raw));
        _path = Path.GetFullPath(resolved);
    }

    public Task<StoredCredential?> GetAsync(CancellationToken cancellationToken = default)
    {
        lock (_lock)
        {
            if (!_loaded)
            {
                _cached = ReadFromDisk();
                _loaded = true;
            }
            return Task.FromResult(_cached);
        }
    }

    public Task SaveAsync(StoredCredential credential, CancellationToken cancellationToken = default)
    {
        lock (_lock)
        {
            var dir = Path.GetDirectoryName(_path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            File.WriteAllText(_path, JsonSerializer.Serialize(credential, Json));
            _cached = credential;
            _loaded = true;
        }
        return Task.CompletedTask;
    }

    public Task DeleteAsync(CancellationToken cancellationToken = default)
    {
        lock (_lock)
        {
            if (File.Exists(_path)) File.Delete(_path);
            _cached = null;
            _loaded = true;
        }
        return Task.CompletedTask;
    }

    private StoredCredential? ReadFromDisk()
    {
        if (!File.Exists(_path)) return null;
        try
        {
            var json = File.ReadAllText(_path);
            return JsonSerializer.Deserialize<StoredCredential>(json, Json);
        }
        catch (JsonException)
        {
            // Corrupt file — treat as absent rather than crash boot.
            return null;
        }
    }
}
