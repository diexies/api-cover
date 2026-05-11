using APICover.Agent.Memory;

namespace APICover.Agent.Tests;

public class MemoryPathSandboxTests
{
    [Theory]
    [InlineData("introduce.md", "introduce.md")]
    [InlineData("Controllers/Payment.md", "controllers/payment.md")]
    [InlineData("services\\payment-service.md", "services/payment-service.md")]
    public void Normalise_AcceptsValid(string input, string expected)
    {
        Assert.Equal(expected, MemoryPathSandbox.Normalise(input));
    }

    [Theory]
    [InlineData("../etc/passwd.md")]
    [InlineData("/abs/path.md")]
    [InlineData("controllers/../../escape.md")]
    [InlineData("controllers/")]
    [InlineData("controllers/foo.txt")]
    [InlineData("contr$ollers/foo.md")]
    [InlineData("")]
    [InlineData("   ")]
    public void Normalise_RejectsInvalid(string input)
    {
        Assert.Throws<ArgumentException>(() => MemoryPathSandbox.Normalise(input));
    }

    [Fact]
    public void ResolveAbsolute_StaysUnderRoot()
    {
        var root = Path.Combine(Path.GetTempPath(), "apicover-sbtest-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var resolved = MemoryPathSandbox.ResolveAbsolute(root, "controllers/payment.md");
            var rootFull = Path.GetFullPath(root);
            Assert.StartsWith(rootFull, resolved);
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }
}
