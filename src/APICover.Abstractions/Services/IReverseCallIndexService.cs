using APICover.Abstractions.Discovery;

namespace APICover.Abstractions.Services;

/// <summary>
/// Builds the "where is this service used?" reverse index from the cached call graphs and
/// answers per-service caller lookups. Populated once at warmup and refreshed on demand.
/// </summary>
public interface IReverseCallIndexService
{
    /// <summary>Walk every call graph in the store and (re)build the in-memory reverse index.
    /// Safe to call multiple times; later calls replace the cached snapshot.</summary>
    Task RebuildAsync(CancellationToken cancellationToken = default);

    /// <summary>Returns null when the service id has never been seen as a callee in any
    /// cached call graph — i.e. dead code, unregistered service, or call-graph warmup not
    /// finished yet.</summary>
    Task<ServiceCallersDto?> GetCallersAsync(string serviceId, CancellationToken cancellationToken = default);

    /// <summary>Method-granular variant: returns only the call sites that hit
    /// <paramref name="declaringType"/>.<paramref name="methodName"/>, plus the endpoint roots
    /// that transitively reach that method via the call graph. Falls back to a concrete impl's
    /// interface when the impl id is passed in but the call sites dispatched through the
    /// interface (mirrors <see cref="GetCallersAsync"/> behaviour).</summary>
    Task<MethodCallersDto?> GetMethodCallersAsync(string declaringType, string methodName, CancellationToken cancellationToken = default);
}
