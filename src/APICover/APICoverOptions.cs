namespace APICover;

/// <summary>
/// Configuration options exposed via <c>AddAPICover(opts =&gt; …)</c>.
/// </summary>
public sealed class APICoverOptions
{
    /// <summary>
    /// Base URL the engine uses when calling back into the host application's endpoints.
    /// When <c>null</c> the middleware resolves the host's address at startup via
    /// <c>IServer.Features</c>.
    /// </summary>
    public Uri? HostBaseAddress { get; set; }

    /// <summary>
    /// Path prefix APICover is mounted at. Defaults to <c>/apicover</c>.
    /// </summary>
    public string PathPrefix { get; set; } = "/apicover";

    /// <summary>Filesystem root for persisted per-scenario run history (last 10 terminal runs).
    /// Null falls back to <c>{ContentRoot}/docs/apicover-history</c>.</summary>
    public string? RunHistoryRoot { get; set; }

    /// <summary>Filesystem root for persisted scenarios. Null falls back to
    /// <c>{ContentRoot}/docs/apicover-scenarios</c>. Each scenario lives at
    /// <c>{ScenarioRoot}/{id}.json</c> and survives process restarts.</summary>
    public string? ScenarioRoot { get; set; }

    /// <summary>Filesystem root for persisted user-defined custom MCP tools. Null falls back
    /// to <c>{ContentRoot}/docs/apicover-custom-tools</c>. Each tool lives at
    /// <c>{CustomToolRoot}/{name}.json</c> and survives process restarts.</summary>
    public string? CustomToolRoot { get; set; }

    /// <summary>
    /// Maximum time the engine waits for a paused breakpoint to be resolved before failing the
    /// node. Defaults to 30 minutes.
    /// </summary>
    public TimeSpan BreakpointTimeout { get; set; } = TimeSpan.FromMinutes(30);

    /// <summary>
    /// Per-node HTTP request timeout. Defaults to 100 seconds.
    /// </summary>
    public TimeSpan HttpTimeout { get; set; } = TimeSpan.FromSeconds(100);

    /// <summary>
    /// Opt in to call-graph inspection: APICover walks each endpoint's IL recursively,
    /// resolves DI interface dispatch to concrete impls, classifies external HTTP and DB
    /// boundaries, and exposes the tree at <c>/apicover/api/call-graphs/{id}</c> + a UI tab.
    /// Default <c>false</c> — zero overhead when off.
    /// </summary>
    public bool EnableCallGraphInspection { get; set; }

    /// <summary>Tunable filters and limits for the IL walker. Used only when
    /// <see cref="EnableCallGraphInspection"/> is true.</summary>
    public CallGraphInspectionOptions CallGraph { get; } = new();
}

/// <summary>Filter and behaviour knobs for the IL walker.</summary>
public sealed class CallGraphInspectionOptions
{
    /// <summary>Build all endpoint graphs in a background hosted service after host startup
    /// so the inspector tab is instantly populated. Default <c>true</c>.</summary>
    public bool EagerBuild { get; set; } = true;

    /// <summary>Maximum recursion depth before emitting a <c>DepthCap</c> leaf.</summary>
    public int MaxDepth { get; set; } = 12;

    /// <summary>If <c>true</c>, framework calls (System.*, Microsoft.Extensions.*, etc.) appear
    /// as their own nodes. Default <c>false</c> hides them entirely.</summary>
    public bool IncludeFrameworkCalls { get; set; }

    /// <summary>Namespace prefixes that the walker treats as framework noise (filtered or
    /// surfaced based on <see cref="IncludeFrameworkCalls"/>).</summary>
    public IList<string> NamespaceExcludeList { get; } = new List<string>
    {
        "System.",
        "Microsoft.Extensions.",
        "Microsoft.AspNetCore.",
        "Microsoft.EntityFrameworkCore.",
        "Microsoft.Data.",
        "Newtonsoft.Json",
        "System.Text.Json",
        "AutoMapper",
        "FluentValidation",
        "Hangfire",
        // Do NOT exclude "MediatR" — the walker hops through Mediator.Send into the registered
        // handler's Handle method (see TryFollowMediator). Excluding it would cut every CQRS
        // path at the dispatcher boundary.
        "Polly",
        "Serilog",
        "StackExchange.Redis",
    };

    /// <summary>If non-empty, restricts the walker to recursing only into methods declared in
    /// these assemblies (by simple name). When empty, the walker auto-derives the user
    /// assembly set from the <c>IServiceCollectionSnapshot</c>.</summary>
    public IList<string> AssemblyIncludeList { get; } = new List<string>();
}
