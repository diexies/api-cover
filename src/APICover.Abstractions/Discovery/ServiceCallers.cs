namespace APICover.Abstractions.Discovery;

/// <summary>
/// Reverse fan-in view for a single service / interface — answers "where is this used?"
/// Built once at warmup by walking every cached call graph and recording, for each service
/// node visited, which endpoint root we came from and the intermediate services in between.
/// </summary>
public sealed class ServiceCallersDto
{
    /// <summary>Fully-qualified declaring type name (matches <see cref="CallNode.DeclaringType"/>).</summary>
    public required string ServiceId { get; init; }

    /// <summary>Short display name (last segment of <see cref="ServiceId"/>).</summary>
    public required string ShortName { get; init; }

    /// <summary>True when <see cref="ServiceId"/> is an interface — paired with
    /// <see cref="ResolvedImplType"/> when a single DI registration was discovered.</summary>
    public bool IsInterface { get; init; }

    /// <summary>Concrete DI implementation when known; null otherwise.</summary>
    public string? ResolvedImplType { get; init; }

    /// <summary>One entry per endpoint that reaches this service (directly or through any
    /// chain of intermediates). <see cref="CallerEntry.Via"/> carries the shortest chain.</summary>
    public IReadOnlyList<CallerEntry> DirectCallers { get; init; } = Array.Empty<CallerEntry>();

    /// <summary>Services that themselves call this one (immediate reverse adjacency).
    /// Useful when the user wants to drill further upward through the call chain.</summary>
    public IReadOnlyList<CallerServiceEntry> CallerServices { get; init; } = Array.Empty<CallerServiceEntry>();

    /// <summary>Method-name → endpoint ids hitting that specific method. Lets the UI offer
    /// a "only callers of FindUserName" filter chip without a second round-trip.</summary>
    public IReadOnlyDictionary<string, IReadOnlyList<string>> MethodCallers { get; init; }
        = new Dictionary<string, IReadOnlyList<string>>();

    /// <summary>Count of unique endpoints transitively reaching this service. Mirrors
    /// <c>DirectCallers.Count</c> but kept as a separate field so future filters can drop
    /// items without losing the headline number.</summary>
    public int TransitiveEndpointCount { get; init; }
}

public sealed class CallerEntry
{
    public required string EndpointId { get; init; }

    /// <summary>Intermediate service ids on the shortest call chain from the endpoint to the
    /// target service, ordered nearest-to-endpoint → nearest-to-target. Empty when the endpoint
    /// hits the service directly.</summary>
    public IReadOnlyList<string> Via { get; init; } = Array.Empty<string>();

    public int CallSites { get; init; }
}

public sealed class CallerServiceEntry
{
    public required string Id { get; init; }
    public required string ShortName { get; init; }

    public IReadOnlyList<string> CalledByEndpoints { get; init; } = Array.Empty<string>();

    // PDB-resolved source metadata — copied verbatim from the originating CallNode so the
    // UI can reuse its existing SourceDrawer / inline snippet rendering without any branch.
    public string? FilePath { get; init; }
    public int? LineNumber { get; init; }
    public int? EndLine { get; init; }
    public string? BodySnippet { get; init; }
    public string? Summary { get; init; }
    public string? MethodName { get; init; }
}
