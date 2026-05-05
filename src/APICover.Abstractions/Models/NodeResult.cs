using System.Text.Json.Nodes;

namespace APICover.Abstractions.Models;

/// <summary>
/// Captured request snapshot for a node within a run. Reflects the actual values sent after
/// JSONLogic evaluation (and any user edits made during a breakpoint).
/// </summary>
public sealed class RequestSnapshot
{
    public required string Method { get; init; }
    public required string Path { get; init; }
    public required string Url { get; init; }
    public IDictionary<string, string> Headers { get; init; } = new Dictionary<string, string>();
    public JsonNode? Body { get; init; }
    public string? ContentType { get; init; }
}

/// <summary>
/// Captured response snapshot for a node within a run.
/// </summary>
public sealed class ResponseSnapshot
{
    public int Status { get; init; }
    public IDictionary<string, string> Headers { get; init; } = new Dictionary<string, string>();
    public JsonNode? Body { get; init; }
    public string? ContentType { get; init; }
}

/// <summary>
/// Per-node execution result inside a run. Stored on the <see cref="Run"/> and exposed via
/// the execution context to downstream nodes.
/// </summary>
public sealed class NodeResult
{
    public required string NodeId { get; init; }

    /// <summary>
    /// Branch path identifying which forked sub-tree this result belongs to. Empty ≡ root (no
    /// fork has happened yet on the path to this node). Each segment is a
    /// <see cref="CaseVariant.Id"/> in the order encountered.
    /// </summary>
    public IList<string> BranchPath { get; init; } = new List<string>();

    public NodeStatus Status { get; set; } = NodeStatus.Pending;

    public RequestSnapshot? Request { get; set; }
    public ResponseSnapshot? Response { get; set; }

    public DateTimeOffset? StartedAt { get; set; }
    public DateTimeOffset? CompletedAt { get; set; }
    public TimeSpan? Duration =>
        StartedAt is null || CompletedAt is null ? null : CompletedAt - StartedAt;

    /// <summary>Error message if the node failed (transport error, evaluation error, etc.).</summary>
    public string? Error { get; set; }

    /// <summary>
    /// When this node belongs to an <see cref="ExecutionGroup"/> with <c>repeat &gt; 1</c>,
    /// each replay produces an entry here. The last iteration is also surfaced on the
    /// node-level fields for backwards-compat consumers (status, request, response).
    /// </summary>
    public IList<NodeIteration> Iterations { get; init; } = new List<NodeIteration>();
}

/// <summary>One execution of a node inside a repeated <see cref="ExecutionGroup"/>.</summary>
public sealed class NodeIteration
{
    public int Index { get; init; }
    public NodeStatus Status { get; init; }
    public RequestSnapshot? Request { get; init; }
    public ResponseSnapshot? Response { get; init; }
    public string? Error { get; init; }
    public DateTimeOffset? StartedAt { get; init; }
    public DateTimeOffset? CompletedAt { get; init; }
}
