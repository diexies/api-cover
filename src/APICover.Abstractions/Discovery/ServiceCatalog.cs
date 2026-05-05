namespace APICover.Abstractions.Discovery;

/// <summary>
/// Aggregate index over every endpoint's <see cref="CallGraphNode"/>: which interfaces /
/// concrete services the host calls, how many endpoints reach each one, what external HTTP
/// and database boundaries are hit. Lets the UI surface a "services" view independent of
/// the per-endpoint internals tab — a top-down map of the system.
/// </summary>
public sealed class ServiceCatalog
{
    public required DateTimeOffset GeneratedAt { get; init; }
    public required IReadOnlyList<ServiceUsageEntry> Services { get; init; }
    public required IReadOnlyList<ExternalBoundary> ExternalHttp { get; init; }
    public required IReadOnlyList<ExternalBoundary> Databases { get; init; }
}

/// <summary>One service surfaced by the aggregator. Combines the interface contract with
/// the resolved implementation type when DI is statically resolvable.</summary>
public sealed class ServiceUsageEntry
{
    /// <summary>Fully-qualified declaring type. For interfaces this is the interface name.</summary>
    public required string DeclaringType { get; init; }

    /// <summary>Short name (last segment) for compact UI display.</summary>
    public required string ShortName { get; init; }

    /// <summary>True when this is an interface contract (vs a concrete user-code class).</summary>
    public required bool IsInterface { get; init; }

    /// <summary>Resolved concrete implementation type when DI lookup found one. Null when
    /// the registration is factory-only or the service isn't an interface.</summary>
    public string? ResolvedImplType { get; init; }

    /// <summary>Distinct endpoint ids that transitively call this service.</summary>
    public required IReadOnlyList<string> UsedByEndpoints { get; init; }

    /// <summary>Distinct method names of this service that are actually called somewhere.
    /// Methods on the interface that no endpoint touches don't appear here — useful for
    /// dead-code spotting.</summary>
    public required IReadOnlyList<string> CalledMethods { get; init; }

    /// <summary>Total call sites across all endpoints (a single endpoint can call the service
    /// from multiple places).</summary>
    public required int TotalCallSites { get; init; }
}

/// <summary>An external HTTP destination or database boundary surfaced from the aggregate.</summary>
public sealed class ExternalBoundary
{
    /// <summary>Display label — for HTTP, the captured URL when known; otherwise the
    /// declaring type + method. For DB, the DbContext + method.</summary>
    public required string Label { get; init; }

    /// <summary>Boundary kind for UI categorisation.</summary>
    public required string Kind { get; init; }     // "ExternalHttp" | "Database"

    /// <summary>Distinct endpoint ids that call this boundary.</summary>
    public required IReadOnlyList<string> UsedByEndpoints { get; init; }

    /// <summary>Total call-site count across all endpoints.</summary>
    public required int TotalCallSites { get; init; }
}
