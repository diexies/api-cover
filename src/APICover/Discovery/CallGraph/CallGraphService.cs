using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using APICover.Abstractions.Discovery;
using APICover.Abstractions.Services;

namespace APICover.Discovery.CallGraph;

/// <summary>
/// Default <see cref="ICallGraphService"/> implementation. Orchestrates: look up the handler
/// <see cref="System.Reflection.MethodInfo"/> via <see cref="IEndpointMethodResolver"/>, hand it to the
/// <see cref="IlWalker"/>, persist via <see cref="ICallGraphStore"/>. Cache misses build on
/// demand; <see cref="RebuildAllAsync"/> is used by the warmup hosted service.
/// </summary>
internal sealed class CallGraphService : ICallGraphService
{
    private readonly IEndpointDiscoveryService _discovery;
    private readonly IEndpointMethodResolver _methodResolver;
    private readonly ICallGraphStore _store;
    private readonly IlWalker _walker;
    private readonly IOptions<APICoverOptions> _options;
    private readonly ILogger<CallGraphService> _logger;

    public CallGraphService(
        IEndpointDiscoveryService discovery,
        IEndpointMethodResolver methodResolver,
        ICallGraphStore store,
        IlWalker walker,
        IOptions<APICoverOptions> options,
        ILogger<CallGraphService> logger)
    {
        _discovery = discovery;
        _methodResolver = methodResolver;
        _store = store;
        _walker = walker;
        _options = options;
        _logger = logger;
    }

    public async Task<CallGraphNode?> GetForEndpointAsync(string endpointId, CancellationToken cancellationToken = default)
    {
        var cached = await _store.GetAsync(endpointId, cancellationToken).ConfigureAwait(false);
        if (cached is not null) return cached;

        var method = _methodResolver.Resolve(endpointId);
        if (method is null) return null;

        var graph = _walker.BuildGraph(endpointId, method);
        await _store.SaveAsync(graph, cancellationToken).ConfigureAwait(false);
        return graph;
    }

    public async Task<IReadOnlyList<CallGraphNode>> RebuildAllAsync(CancellationToken cancellationToken = default)
    {
        await _store.DeleteAllAsync(cancellationToken).ConfigureAwait(false);
        var endpoints = _discovery.GetEndpoints();
        var built = new List<CallGraphNode>(endpoints.Count);

        // Throttle to half the available cores so app startup work doesn't get crowded out.
        var dop = Math.Max(1, Environment.ProcessorCount / 2);
        var semaphore = new SemaphoreSlim(dop);
        var tasks = endpoints.Select(async ep =>
        {
            await semaphore.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                if (cancellationToken.IsCancellationRequested) return;
                var method = _methodResolver.Resolve(ep.Id);
                if (method is null) return;
                var graph = _walker.BuildGraph(ep.Id, method);
                await _store.SaveAsync(graph, cancellationToken).ConfigureAwait(false);
                lock (built) built.Add(graph);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to build call graph for endpoint {EndpointId}", ep.Id);
            }
            finally
            {
                semaphore.Release();
            }
        });
        await Task.WhenAll(tasks).ConfigureAwait(false);
        return built;
    }
}
