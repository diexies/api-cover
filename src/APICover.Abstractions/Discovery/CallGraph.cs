namespace APICover.Abstractions.Discovery;

/// <summary>
/// Per-endpoint call graph: the rooted tree of methods the endpoint's handler invokes,
/// recursively, with DI interface→impl resolution and external-boundary classification.
/// One graph per <see cref="EndpointDescriptor.Id"/>; cached and rebuilt only when the
/// host's assembly set changes (cache key = <see cref="AssemblyHash"/>).
/// </summary>
public sealed class CallGraphNode
{
    /// <summary>Matches <see cref="EndpointDescriptor.Id"/>, e.g. <c>"GET /users/{id}"</c>.</summary>
    public required string EndpointId { get; init; }

    /// <summary>Display name of the root handler, e.g. <c>"BillingController.CreateInvoice"</c>.</summary>
    public required string RootMethod { get; init; }

    /// <summary>When the graph was generated. Used to surface staleness in the UI.</summary>
    public required DateTimeOffset GeneratedAt { get; init; }

    /// <summary>SHA-256 of the host's assembly MVID set at build time. The cache busts when
    /// any user assembly is replaced (deploy / hot-swap).</summary>
    public required string AssemblyHash { get; init; }

    /// <summary>The root call node — always the controller method itself.</summary>
    public required CallNode RootCall { get; init; }

    /// <summary>Soft warnings emitted during the walk (e.g. "depth cap hit at X").</summary>
    public IReadOnlyList<string> Warnings { get; init; } = Array.Empty<string>();
}

/// <summary>
/// One node in a <see cref="CallGraphNode"/> tree. Recursive: <see cref="Calls"/> contains
/// child nodes for each method this method invokes (filtered + classified).
/// </summary>
public sealed class CallNode
{
    /// <summary>Friendly display name, e.g. <c>"IUserService.GetById"</c>.</summary>
    public required string DisplayName { get; init; }

    /// <summary>Fully-qualified declaring type name (or null for synthetic nodes).</summary>
    public string? DeclaringType { get; init; }

    /// <summary>Method name without parameters.</summary>
    public string? MethodName { get; init; }

    /// <summary>Full type names of the method's parameters in declaration order.</summary>
    public IReadOnlyList<string> ParameterTypes { get; init; } = Array.Empty<string>();

    /// <summary>Classification — drives the UI rendering and tells the walker whether to recurse.</summary>
    public required CallNodeKind Kind { get; init; }

    /// <summary>When <see cref="Kind"/> is <see cref="CallNodeKind.Interface"/> and DI resolved a
    /// concrete implementation, the impl's full type name. Null otherwise.</summary>
    public string? ResolvedImplType { get; init; }

    /// <summary>Free-form annotation: captured URL for an HTTP boundary, "(async)" for unwrapped
    /// state machines, "factory-resolved" for delegate-based DI, etc.</summary>
    public string? Notes { get; init; }

    /// <summary>Source file (only when a portable PDB is available beside the assembly).</summary>
    public string? FilePath { get; init; }

    /// <summary>Source line (only when a portable PDB is available beside the assembly).</summary>
    public int? LineNumber { get; init; }

    /// <summary>Last source line of the method body — pairs with <see cref="LineNumber"/> so
    /// the UI can scroll-to and highlight the exact method range in the source viewer.</summary>
    public int? EndLine { get; init; }

    /// <summary>Free-form description sourced from <see cref="ExploreSummaryAttribute"/> on
    /// the method (preferred) or its declaring type. Surfaces in the UI under the call name
    /// so a reader sees "what this does" without opening the source.</summary>
    public string? Summary { get; init; }

    /// <summary>IL-level signals extracted from the method body: exception throws, log/string
    /// literals, branch counts. Surfaces decision points and intent hints in the UI without
    /// forcing the user to open source code. Null when the walker couldn't read IL.</summary>
    public IReadOnlyList<CallSignal>? Signals { get; init; }

    /// <summary>First 6–8 source lines of the method body, pulled via PDB sequence points.
    /// Lines joined with `\n`, common leading whitespace stripped, long lines truncated.
    /// Null when no portable PDB is available, the file is missing, or the slice is empty.
    /// The UI renders this directly under the node so the user reads real C# instead of
    /// guessing what a service does from its name.</summary>
    public string? BodySnippet { get; init; }

    /// <summary>Children — invoked methods, recursively. Empty for leaf nodes (boundaries, cycle, etc.).</summary>
    public IReadOnlyList<CallNode> Calls { get; init; } = Array.Empty<CallNode>();
}

/// <summary>A single piece of IL-derived intent context attached to a method node.</summary>
public sealed class CallSignal
{
    /// <summary>Signal classification.</summary>
    public required CallSignalKind Kind { get; init; }

    /// <summary>Human-readable text — exception type, log message literal, branch count, etc.</summary>
    public required string Text { get; init; }
}

/// <summary>What kind of IL signal we captured.</summary>
public enum CallSignalKind
{
    /// <summary>Method throws an exception type (e.g. NotFoundException, ArgumentException).</summary>
    Throws = 0,
    /// <summary>String literal passed to a logger / message channel — first-arg ldstr.</summary>
    LogMessage = 1,
    /// <summary>Conditional branch count (brfalse/brtrue/switch) — rough complexity signal.</summary>
    Branches = 2,
    /// <summary>String literal we couldn't classify (validation message, etc.).</summary>
    Literal = 3,
}

/// <summary>How the walker classified a given call. Drives both the UI badge and whether
/// the walker recurses into the method body.</summary>
public enum CallNodeKind
{
    /// <summary>The root controller / minimal-API handler. Recursed into.</summary>
    ControllerMethod = 0,
    /// <summary>User-code method in a host assembly. Recursed into.</summary>
    Method = 1,
    /// <summary>Interface dispatch. <see cref="CallNode.ResolvedImplType"/> is set when DI lookup
    /// found exactly one registration; the impl is recursed into via the resolved <c>MethodInfo</c>.
    /// Multi-impl or open-generic registrations emit child nodes per impl, capped at 3 + an overflow
    /// summary leaf.</summary>
    Interface = 2,
    /// <summary>HTTP egress to another service. Walking stops here; <see cref="CallNode.Notes"/>
    /// may carry an inferred URL captured from the IL (best-effort <c>ldstr</c> back-walk).</summary>
    ExternalHttp = 3,
    /// <summary>Database call (EF Core, Dapper, IQueryable terminal). Walking stops here.</summary>
    Database = 4,
    /// <summary>Framework / runtime call surfaced when <c>IncludeFrameworkCalls = true</c>.
    /// Otherwise filtered before emission. No recursion.</summary>
    Framework = 5,
    /// <summary>Cycle truncation — this method already appears higher in the call stack. Leaf.</summary>
    Cycle = 6,
    /// <summary>Depth-cap truncation. Leaf.</summary>
    DepthCap = 7,
    /// <summary>Reflection / Activator / Expression.Compile / DI factory delegate — body cannot
    /// be statically resolved. Leaf.</summary>
    Dynamic = 8,
    /// <summary>Method body unavailable (abstract / native / P-Invoke / open-generic without
    /// instantiation context). Leaf.</summary>
    Opaque = 9,
}
