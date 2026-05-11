using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.DependencyInjection;
using APICover.Agent.Credentials;

namespace APICover.Agent.Tests;

public class CredentialEncryptionTests
{
    [Fact]
    public void Protect_ThenUnprotect_RoundTrips()
    {
        var encryption = NewEncryption();

        var plaintext = "sk-ant-secret-key-12345";
        var ciphertext = encryption.Protect(plaintext);
        var roundTripped = encryption.Unprotect(ciphertext);

        Assert.Equal(plaintext, roundTripped);
        Assert.NotEqual(plaintext, ciphertext);
    }

    [Fact]
    public void LastFour_ReturnsLastFourChars()
    {
        Assert.Equal("2345", CredentialEncryption.LastFour("sk-ant-secret-key-12345"));
        Assert.Equal("abc", CredentialEncryption.LastFour("abc"));
        Assert.Equal(string.Empty, CredentialEncryption.LastFour(string.Empty));
    }

    [Fact]
    public void Protect_RejectsEmpty()
    {
        var encryption = NewEncryption();
        Assert.Throws<ArgumentException>(() => encryption.Protect(string.Empty));
    }

    private static CredentialEncryption NewEncryption()
    {
        var services = new ServiceCollection();
        services.AddDataProtection();
        var provider = services.BuildServiceProvider().GetRequiredService<IDataProtectionProvider>();
        return new CredentialEncryption(provider);
    }
}
