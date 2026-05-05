using APICover.Abstractions.Discovery;

namespace APICover.Abstractions.Services;

/// <summary>Builds the cross-endpoint <see cref="ServiceCatalog"/> on demand from the
/// <see cref="ICallGraphStore"/>. Pure aggregation — no IL walking — so it's cheap to
/// invoke even with hundreds of endpoints.</summary>
public interface IServiceCatalogService
{
    Task<ServiceCatalog> BuildAsync(CancellationToken cancellationToken = default);
}
