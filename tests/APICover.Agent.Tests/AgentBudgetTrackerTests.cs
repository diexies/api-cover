using Microsoft.Extensions.Options;
using APICover.Agent;
using APICover.Agent.Engine;

namespace APICover.Agent.Tests;

public class AgentBudgetTrackerTests
{
    [Fact]
    public void TryStartRun_AllowsFirstRun()
    {
        var tracker = NewTracker(new AgentOptions { MaxDollarsPerDay = 5m });
        var result = tracker.TryStartRun(perCredentialCap: null);
        Assert.True(result.Allowed);
        tracker.CompleteRun();
    }

    [Fact]
    public void TryStartRun_RejectsWhenConcurrentCapHit()
    {
        var opts = new AgentOptions { MaxConcurrentRunsPerWorkspace = 1 };
        var tracker = NewTracker(opts);

        var first = tracker.TryStartRun(null);
        var second = tracker.TryStartRun(null);

        Assert.True(first.Allowed);
        Assert.False(second.Allowed);
        Assert.Contains("Concurrent", second.Reason);
        tracker.CompleteRun();
    }

    [Fact]
    public void Accrue_FlagsExhausted_WhenCapReached()
    {
        var tracker = NewTracker(new AgentOptions { MaxDollarsPerDay = 0.01m });

        // 1M input tokens at $15/Mtok = $15.
        var result = tracker.Accrue(1_000_000, 0, perCredentialCap: null);

        Assert.True(result.Exhausted);
        Assert.True(result.SpentToday >= 0.01m);
    }

    [Fact]
    public void ResolveDailyCap_PicksLowerOfTwo()
    {
        var tracker = NewTracker(new AgentOptions { MaxDollarsPerDay = 5m });

        var cap = tracker.ResolveDailyCap(perCredentialCap: 2m);

        Assert.Equal(2m, cap);
    }

    [Fact]
    public void ResolveDailyCap_NullWhenBothNull()
    {
        var tracker = NewTracker(new AgentOptions { MaxDollarsPerDay = null });
        var cap = tracker.ResolveDailyCap(null);
        Assert.Null(cap);
    }

    [Fact]
    public void EstimateDollars_UsesPublicOpusRates()
    {
        var tracker = NewTracker(new AgentOptions());

        // 1M input tokens × $15 + 1M output × $75 = $90.
        var dollars = tracker.EstimateDollars(1_000_000, 1_000_000);

        Assert.Equal(90m, dollars);
    }

    private static AgentBudgetTracker NewTracker(AgentOptions options)
        => new(Options.Create(options));
}
