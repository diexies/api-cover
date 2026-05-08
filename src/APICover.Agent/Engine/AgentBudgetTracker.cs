using Microsoft.Extensions.Options;

namespace APICover.Agent.Engine;

/// <summary>
/// Per-process sliding-window budget tracker. M1 keeps state in memory; multi-instance
/// deployments will need a shared store later (deferred). Cost estimates use Anthropic's
/// public Opus 4.7 list rate ($15 / Mtok input, $75 / Mtok output) as of 2026 — override
/// via <see cref="SetRates"/> if rates change.
/// </summary>
public sealed class AgentBudgetTracker
{
    private readonly IOptions<AgentOptions> _options;
    private readonly object _lock = new();
    private decimal _dollarsToday;
    private DateOnly _today = DateOnly.FromDateTime(DateTime.UtcNow);
    private readonly Queue<DateTimeOffset> _runStartTimes = new();
    private int _activeRuns;

    public decimal InputDollarsPerMillionTokens { get; private set; } = 15.00m;
    public decimal OutputDollarsPerMillionTokens { get; private set; } = 75.00m;

    public AgentBudgetTracker(IOptions<AgentOptions> options)
    {
        _options = options;
    }

    public void SetRates(decimal inputPerMtok, decimal outputPerMtok)
    {
        InputDollarsPerMillionTokens = inputPerMtok;
        OutputDollarsPerMillionTokens = outputPerMtok;
    }

    /// <summary>Resolve the effective daily cap for a credential: lower of per-credential
    /// cap and global <see cref="AgentOptions.MaxDollarsPerDay"/>.</summary>
    public decimal? ResolveDailyCap(decimal? perCredentialCap)
    {
        var global = _options.Value.MaxDollarsPerDay;
        return (perCredentialCap, global) switch
        {
            (null, null) => null,
            (null, var g) => g,
            (var c, null) => c,
            (var c, var g) => Math.Min(c!.Value, g!.Value)
        };
    }

    public decimal EstimateDollars(int inputTokens, int outputTokens)
    {
        return inputTokens / 1_000_000m * InputDollarsPerMillionTokens
             + outputTokens / 1_000_000m * OutputDollarsPerMillionTokens;
    }

    public sealed record StartCheck(bool Allowed, string? Reason, decimal SpentToday, decimal? DailyCap);

    public StartCheck TryStartRun(decimal? perCredentialCap)
    {
        lock (_lock)
        {
            RolloverIfNewDay();
            PruneOldRunStarts();

            var cap = ResolveDailyCap(perCredentialCap);
            if (cap is not null && _dollarsToday >= cap.Value)
            {
                return new StartCheck(false,
                    $"Daily AI budget reached ({_dollarsToday:C} / {cap.Value:C}).",
                    _dollarsToday, cap);
            }
            if (_activeRuns >= _options.Value.MaxConcurrentRunsPerWorkspace)
            {
                return new StartCheck(false,
                    $"Concurrent run cap reached ({_activeRuns} / {_options.Value.MaxConcurrentRunsPerWorkspace}).",
                    _dollarsToday, cap);
            }
            if (_runStartTimes.Count >= _options.Value.MaxRunsPerHour)
            {
                return new StartCheck(false,
                    $"Hourly run cap reached ({_runStartTimes.Count} / {_options.Value.MaxRunsPerHour}).",
                    _dollarsToday, cap);
            }

            _activeRuns++;
            _runStartTimes.Enqueue(DateTimeOffset.UtcNow);
            return new StartCheck(true, null, _dollarsToday, cap);
        }
    }

    public void CompleteRun()
    {
        lock (_lock)
        {
            if (_activeRuns > 0) _activeRuns--;
        }
    }

    /// <summary>Record dollars spent on one Anthropic round-trip and check whether the
    /// daily cap is now exceeded.</summary>
    public sealed record AccrueResult(decimal SpentToday, decimal? DailyCap, bool Exhausted);

    public AccrueResult Accrue(int inputTokens, int outputTokens, decimal? perCredentialCap)
    {
        lock (_lock)
        {
            RolloverIfNewDay();
            var dollars = EstimateDollars(inputTokens, outputTokens);
            _dollarsToday += dollars;
            var cap = ResolveDailyCap(perCredentialCap);
            var exhausted = cap is not null && _dollarsToday >= cap.Value;
            return new AccrueResult(_dollarsToday, cap, exhausted);
        }
    }

    public decimal SpentToday
    {
        get { lock (_lock) { RolloverIfNewDay(); return _dollarsToday; } }
    }

    private void RolloverIfNewDay()
    {
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        if (today != _today)
        {
            _today = today;
            _dollarsToday = 0m;
        }
    }

    private void PruneOldRunStarts()
    {
        var cutoff = DateTimeOffset.UtcNow - TimeSpan.FromHours(1);
        while (_runStartTimes.Count > 0 && _runStartTimes.Peek() < cutoff)
        {
            _runStartTimes.Dequeue();
        }
    }
}
