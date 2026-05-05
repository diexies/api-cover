using System.Text.Json.Nodes;
using APICover.Abstractions.Models;

namespace APICover.Abstractions.Services;

/// <summary>Options for starting a scenario run.</summary>
public sealed class RunOptions
{
    /// <summary>Initial input (exposed to rules as <c>input.*</c>).</summary>
    public JsonObject? Input { get; init; }

    /// <summary>If <c>true</c>, breakpoints defined on the scenario are honoured.</summary>
    public bool BreakpointsEnabled { get; init; } = true;

    /// <summary>
    /// Headers injected into every HTTP request the engine emits during this run, applied on
    /// top of node-declared headers (run options win on collision). Used by the UI's auth
    /// modal to attach a Bearer token / API key / Basic credential without polluting the
    /// stored scenario JSON.
    /// </summary>
    public IReadOnlyDictionary<string, string>? Headers { get; init; }

    /// <summary>
    /// Query-string parameters appended to every HTTP request URL. Like <see cref="Headers"/>
    /// — covers the API-key-in-query auth flavour.
    /// </summary>
    public IReadOnlyDictionary<string, string>? QueryParameters { get; init; }

    /// <summary>Limits applied when a scenario contains <see cref="CaseSet"/> branching. Run-level
    /// override; engine falls back to defaults when null.</summary>
    public BranchCaps? BranchCaps { get; init; }
}

/// <summary>Hard limits the engine enforces against case-based branching to prevent runaway
/// fan-out (multiplicative composition turns easy authoring into a load test).</summary>
public sealed class BranchCaps
{
    /// <summary>Default permissive caps: 128 / warn 32 / 16 concurrent / 4000 leaf invocations.</summary>
    public static BranchCaps Defaults { get; } = new();

    /// <summary>Hard ceiling on total branches per run. Pre-flight estimate above this rejects
    /// the run before any HTTP call is issued.</summary>
    public int MaxBranches { get; init; } = 128;

    /// <summary>UI advisory threshold; prompts the user to confirm before launching when the
    /// estimated branch count exceeds this number (and is still under <see cref="MaxBranches"/>).</summary>
    public int WarnAt { get; init; } = 32;

    /// <summary>Maximum branches allowed to execute concurrently. Beyond this, branches queue.</summary>
    public int MaxConcurrentBranches { get; init; } = 16;

    /// <summary>Defensive ceiling on total HTTP invocations across all branches. If exceeded
    /// at runtime the engine aborts the run.</summary>
    public int MaxLeafInvocations { get; init; } = 4000;
}

/// <summary>
/// Executes scenarios. Implementations are responsible for evaluating node request rules
/// against the execution context, performing the HTTP calls, recording results, and
/// honouring breakpoints via <see cref="IBreakpointController"/>.
/// </summary>
public interface IScenarioEngine
{
    /// <summary>Starts a new run and returns immediately with the created <see cref="Run"/>.</summary>
    Task<Run> StartAsync(Scenario scenario, RunOptions? options = null, CancellationToken cancellationToken = default);
}
