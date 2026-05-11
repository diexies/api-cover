namespace APICover.Agent.Credentials;

/// <summary>
/// Resolves the active credential for the current workspace. Throws
/// <see cref="InvalidOperationException"/> when no credential is configured — endpoints
/// guard with a status check before reaching here.
/// </summary>
public interface IClaudeCredentialProvider
{
    ValueTask<ClaudeCredential> GetAsync(CancellationToken cancellationToken);
}
