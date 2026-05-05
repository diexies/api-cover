using APICover.Abstractions.Models;

namespace APICover.Abstractions.Services;

/// <summary>
/// Action requested by the user when a run is paused at a breakpoint.
/// </summary>
public enum BreakpointAction
{
    /// <summary>Continue execution with the (possibly edited) request.</summary>
    Resume = 0,

    /// <summary>Skip this node entirely and continue with downstream nodes.</summary>
    Skip = 1,

    /// <summary>Abort the entire run.</summary>
    Abort = 2
}

/// <summary>Decision made by the user for a paused breakpoint.</summary>
public sealed class BreakpointDecision
{
    public required BreakpointAction Action { get; init; }

    /// <summary>
    /// When <see cref="Action"/> is <see cref="BreakpointAction.Resume"/>, optionally replaces
    /// the request snapshot that will be sent. <c>null</c> keeps the original.
    /// </summary>
    public RequestSnapshot? EditedRequest { get; init; }
}

/// <summary>
/// Coordinates breakpoint pause/resume between the running engine and external controllers
/// (the SignalR hub, integration tests, …).
/// </summary>
public interface IBreakpointController
{
    /// <summary>
    /// Called by the engine when execution reaches a node with an enabled breakpoint. Awaits
    /// the user's decision (or cancellation).
    /// </summary>
    Task<BreakpointDecision> WaitForDecisionAsync(string runId, string nodeId, RequestSnapshot pendingRequest, CancellationToken cancellationToken);

    /// <summary>Provides the user's decision for a previously paused breakpoint.</summary>
    Task ResolveAsync(string runId, string nodeId, BreakpointDecision decision, CancellationToken cancellationToken = default);
}
