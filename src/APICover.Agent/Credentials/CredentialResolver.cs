using Microsoft.Extensions.Options;

namespace APICover.Agent.Credentials;

/// <summary>
/// Default <see cref="IClaudeCredentialProvider"/>. Reads the workspace's stored credential,
/// decrypts the API key when present, and returns the typed record. Honours
/// <see cref="AgentOptions.AllowMaxSubscription"/> / <see cref="AgentOptions.AllowApiKey"/>.
/// </summary>
internal sealed class CredentialResolver : IClaudeCredentialProvider
{
    private readonly IAgentCredentialStore _store;
    private readonly CredentialEncryption _encryption;
    private readonly MaxSubscriptionProbe _probe;
    private readonly IOptions<AgentOptions> _options;

    public CredentialResolver(
        IAgentCredentialStore store,
        CredentialEncryption encryption,
        MaxSubscriptionProbe probe,
        IOptions<AgentOptions> options)
    {
        _store = store;
        _encryption = encryption;
        _probe = probe;
        _options = options;
    }

    public async ValueTask<ClaudeCredential> GetAsync(CancellationToken cancellationToken)
    {
        var stored = await _store.GetAsync(cancellationToken);
        if (stored is null || stored.Mode == AgentCredentialMode.Disabled)
        {
            throw new InvalidOperationException("No agent credential configured.");
        }

        var opts = _options.Value;

        if (stored.Mode == AgentCredentialMode.Max)
        {
            if (!opts.AllowMaxSubscription)
            {
                throw new InvalidOperationException("Max subscription mode is disabled by AgentOptions.");
            }
            var probe = _probe.Probe();
            if (!probe.Available || probe.CliPath is null)
            {
                throw new InvalidOperationException(
                    $"claude CLI not available: {probe.Error ?? "not found"}");
            }
            return new MaxSubscriptionCredential(probe.CliPath);
        }

        if (stored.Mode == AgentCredentialMode.ApiKey)
        {
            if (!opts.AllowApiKey)
            {
                throw new InvalidOperationException("API-key mode is disabled by AgentOptions.");
            }
            if (string.IsNullOrEmpty(stored.EncryptedApiKey))
            {
                throw new InvalidOperationException("API-key credential present but key is empty.");
            }
            var key = _encryption.Unprotect(stored.EncryptedApiKey);
            return new ApiKeyCredential(key, stored.DailyDollarCap);
        }

        throw new InvalidOperationException($"Unknown credential mode: {stored.Mode}.");
    }
}
