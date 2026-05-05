using System.Collections.Concurrent;
using APICover.Abstractions.Models;
using APICover.Abstractions.Services;

namespace APICover.Engine.Breakpoints;

/// <summary>
/// Default <see cref="IBreakpointController"/> backed by per-(run, node) <see cref="TaskCompletionSource"/>s.
/// External controllers (the SignalR hub, integration tests, …) call <see cref="ResolveAsync"/>
/// to unblock a paused engine. Pending pauses can be observed via <see cref="GetPending"/>
/// (used by the HTTP API / hub when a client connects after a pause).
/// </summary>
public sealed class DefaultBreakpointController : IBreakpointController
{
    private readonly ConcurrentDictionary<(string runId, string nodeId), PendingBreakpoint> _pending = new();

    /// <summary>Snapshot of currently-paused breakpoints (for late subscribers).</summary>
    public IReadOnlyDictionary<(string runId, string nodeId), RequestSnapshot> GetPending() =>
        _pending.ToDictionary(kv => kv.Key, kv => kv.Value.Request);

    /// <summary>Raised when a node enters the paused state.</summary>
    public event Action<string, string, RequestSnapshot>? Paused;

    /// <summary>Raised when a paused breakpoint is resolved (any action).</summary>
    public event Action<string, string, BreakpointDecision>? Resolved;

    public async Task<BreakpointDecision> WaitForDecisionAsync(
        string runId, string nodeId, RequestSnapshot pendingRequest, CancellationToken cancellationToken)
    {
        var key = (runId, nodeId);
        var pending = new PendingBreakpoint(pendingRequest);
        if (!_pending.TryAdd(key, pending))
        {
            throw new InvalidOperationException(
                $"A breakpoint for run '{runId}' node '{nodeId}' is already pending.");
        }

        try
        {
            Paused?.Invoke(runId, nodeId, pendingRequest);
            using var registration = cancellationToken.Register(
                () => pending.Source.TrySetCanceled(cancellationToken));
            return await pending.Source.Task.ConfigureAwait(false);
        }
        finally
        {
            _pending.TryRemove(key, out _);
        }
    }

    public Task ResolveAsync(string runId, string nodeId, BreakpointDecision decision, CancellationToken cancellationToken = default)
    {
        var key = (runId, nodeId);
        if (!_pending.TryGetValue(key, out var pending))
        {
            throw new InvalidOperationException(
                $"No pending breakpoint for run '{runId}' node '{nodeId}'.");
        }
        if (pending.Source.TrySetResult(decision))
        {
            Resolved?.Invoke(runId, nodeId, decision);
        }
        return Task.CompletedTask;
    }

    private sealed class PendingBreakpoint
    {
        public PendingBreakpoint(RequestSnapshot request)
        {
            Request = request;
            Source = new TaskCompletionSource<BreakpointDecision>(TaskCreationOptions.RunContinuationsAsynchronously);
        }

        public RequestSnapshot Request { get; }
        public TaskCompletionSource<BreakpointDecision> Source { get; }
    }
}
