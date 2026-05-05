using APICover.Abstractions.Discovery;

namespace APICover.Abstractions.Services;

/// <summary>
/// Build / read / refresh the per-endpoint call graphs. Lookup by
/// <see cref="EndpointDescriptor.Id"/>; misses fall through to a fresh build via the IL walker.
/// </summary>
public interface ICallGraphService
{
    /// <summary>Returns the cached graph for <paramref name="endpointId"/>, building it on
    /// demand if absent. Returns <c>null</c> only when the endpoint is unknown.</summary>
    Task<CallGraphNode?> GetForEndpointAsync(string endpointId, CancellationToken cancellationToken = default);

    /// <summary>Rebuild every endpoint's graph (invalidates cache, walks IL again).</summary>
    Task<IReadOnlyList<CallGraphNode>> RebuildAllAsync(CancellationToken cancellationToken = default);
}

/// <summary>
/// Persistence boundary for call graphs. Default implementation is in-memory; EF-backed
/// providers can layer on top later without touching the engine.
/// </summary>
public interface ICallGraphStore
{
    Task<CallGraphNode?> GetAsync(string endpointId, CancellationToken cancellationToken = default);
    Task SaveAsync(CallGraphNode graph, CancellationToken cancellationToken = default);
    Task<IReadOnlyList<CallGraphNode>> ListAsync(CancellationToken cancellationToken = default);
    Task DeleteAllAsync(CancellationToken cancellationToken = default);
}
