using APICover.Abstractions.Discovery;

namespace APICover.Abstractions.Services;

/// <summary>
/// Builds the topology <see cref="ServiceMap"/> on demand from cached
/// <see cref="CallGraphNode"/>s. Pure aggregation — no IL walking.
/// </summary>
public interface IServiceMapService
{
    Task<ServiceMap> BuildAsync(CancellationToken cancellationToken = default);
}
