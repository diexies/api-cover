namespace APICover.Abstractions.Models;

/// <summary>
/// A breakpoint set on a node. When the engine reaches a node that has an enabled breakpoint
/// the run pauses before issuing the HTTP call so the user can inspect prior responses and
/// edit the outgoing request.
/// </summary>
public sealed class Breakpoint
{
    public required string NodeId { get; init; }

    public bool Enabled { get; set; } = true;

    /// <summary>Optional label for the breakpoint shown in the UI.</summary>
    public string? Label { get; init; }
}
