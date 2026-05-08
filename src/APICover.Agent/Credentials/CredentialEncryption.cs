using System.Text;
using Microsoft.AspNetCore.DataProtection;

namespace APICover.Agent.Credentials;

/// <summary>
/// Round-trips API keys through ASP.NET Core Data Protection. Purpose string scopes the
/// protector so other callers can't decrypt what we store. Falls back to a process-only
/// in-memory protector if Data Protection isn't registered (single-process dev only —
/// ciphertext won't survive restart).
/// </summary>
internal sealed class CredentialEncryption
{
    private const string Purpose = "APICover.AgentCredential";
    private readonly IDataProtector _protector;

    public CredentialEncryption(IDataProtectionProvider provider)
    {
        _protector = provider.CreateProtector(Purpose);
    }

    public string Protect(string plaintext)
    {
        ArgumentException.ThrowIfNullOrEmpty(plaintext);
        var bytes = Encoding.UTF8.GetBytes(plaintext);
        return Convert.ToBase64String(_protector.Protect(bytes));
    }

    public string Unprotect(string ciphertext)
    {
        ArgumentException.ThrowIfNullOrEmpty(ciphertext);
        var bytes = _protector.Unprotect(Convert.FromBase64String(ciphertext));
        return Encoding.UTF8.GetString(bytes);
    }

    public static string LastFour(string apiKey)
    {
        if (string.IsNullOrEmpty(apiKey)) return string.Empty;
        return apiKey.Length <= 4 ? apiKey : apiKey[^4..];
    }
}
