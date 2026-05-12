using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using APICover.Abstractions.Services;

namespace APICover.Discovery.CallGraph;

/// <summary>
/// Optional eager warmup for call-graph inspection. After the host finishes startup, kicks off
/// a fire-and-forget pass that walks every endpoint's IL so the inspector tab is instantly
/// populated when the user clicks. Bails immediately when
/// <see cref="APICoverOptions.EnableCallGraphInspection"/> or
/// <see cref="CallGraphInspectionOptions.EagerBuild"/> is false. Cancellation is honoured on
/// host shutdown so a half-finished walk doesn't block teardown.
/// </summary>
internal sealed class CallGraphWarmupHostedService : IHostedService
{
    private readonly ICallGraphService _service;
    private readonly IReverseCallIndexService _reverseIndex;
    private readonly IOptions<APICoverOptions> _options;
    private readonly ILogger<CallGraphWarmupHostedService> _logger;
    private CancellationTokenSource? _cts;

    public CallGraphWarmupHostedService(
        ICallGraphService service,
        IReverseCallIndexService reverseIndex,
        IOptions<APICoverOptions> options,
        ILogger<CallGraphWarmupHostedService> logger)
    {
        _service = service;
        _reverseIndex = reverseIndex;
        _options = options;
        _logger = logger;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        var opts = _options.Value;
        if (!opts.EnableCallGraphInspection || !opts.CallGraph.EagerBuild)
        {
            return Task.CompletedTask;
        }

        _cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var ct = _cts.Token;

        // Fire-and-forget; never blocks startup.
        _ = Task.Run(async () =>
        {
            try
            {
                _logger.LogInformation("APICover call-graph warmup starting…");
                var t = DateTimeOffset.UtcNow;
                var built = await _service.RebuildAllAsync(ct).ConfigureAwait(false);
                _logger.LogInformation("APICover call-graph warmup built {Count} graph(s) in {Elapsed}.",
                    built.Count, DateTimeOffset.UtcNow - t);
                // Reverse fan-in index — answers "where is this service used?" without
                // re-walking call graphs on every UI request. Single pass over the cache.
                var revStart = DateTimeOffset.UtcNow;
                await _reverseIndex.RebuildAsync(ct).ConfigureAwait(false);
                _logger.LogInformation("APICover reverse-call index built in {Elapsed}.",
                    DateTimeOffset.UtcNow - revStart);
            }
            catch (OperationCanceledException)
            {
                // Host shutting down — fine.
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "APICover call-graph warmup failed.");
            }
        }, ct);

        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _cts?.Cancel();
        return Task.CompletedTask;
    }
}
