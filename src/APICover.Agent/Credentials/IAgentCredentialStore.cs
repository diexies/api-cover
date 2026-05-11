namespace APICover.Agent.Credentials;

/// <summary>
/// Persistence for the workspace's selected credential mode + (encrypted) API key.
/// Implementations live in the storage provider packages; default in-memory impl ships
/// with this package.
/// </summary>
public interface IAgentCredentialStore
{
    Task<StoredCredential?> GetAsync(CancellationToken cancellationToken = default);

    Task SaveAsync(StoredCredential credential, CancellationToken cancellationToken = default);

    Task DeleteAsync(CancellationToken cancellationToken = default);
}

/// <summary>What gets persisted. <see cref="EncryptedApiKey"/> is opaque ciphertext —
/// only the credential resolver knows how to decrypt it. Plain key never crosses this
/// boundary.</summary>
public sealed record StoredCredential(
    AgentCredentialMode Mode,
    string? EncryptedApiKey,
    string? LastFourChars,
    decimal? DailyDollarCap,
    DateTimeOffset UpdatedAt);

public enum AgentCredentialMode
{
    Disabled = 0,
    ApiKey = 1,
    Max = 2
}
