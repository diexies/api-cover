using APICover.Agent.Credentials;

namespace APICover.Agent.Tests;

public class MaxSubscriptionProbeTests
{
    [Fact]
    public void Probe_DoesNotThrow_WhenCliMissing()
    {
        var probe = new MaxSubscriptionProbe();
        // We don't assert on Available — CI may or may not have claude installed —
        // we only assert that the method returns and the result shape is well-formed.
        var result = probe.Probe();
        Assert.NotNull(result);
        if (!result.Available)
        {
            Assert.NotNull(result.Error);
        }
    }

    [Fact]
    public void Probe_CachesResult()
    {
        var probe = new MaxSubscriptionProbe();
        var first = probe.Probe();
        var second = probe.Probe();
        Assert.Same(first, second);
    }
}
