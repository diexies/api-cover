namespace APICover.Agent.Credentials;

internal sealed class InMemoryAgentCredentialStore : IAgentCredentialStore
{
    private StoredCredential? _current;
    private readonly object _lock = new();

    public Task<StoredCredential?> GetAsync(CancellationToken cancellationToken = default)
    {
        lock (_lock) return Task.FromResult(_current);
    }

    public Task SaveAsync(StoredCredential credential, CancellationToken cancellationToken = default)
    {
        lock (_lock) _current = credential;
        return Task.CompletedTask;
    }

    public Task DeleteAsync(CancellationToken cancellationToken = default)
    {
        lock (_lock) _current = null;
        return Task.CompletedTask;
    }
}
