using System.Text.Json.Nodes;

namespace APICover.Abstractions.Models;

/// <summary>
/// A repeatable subgraph: the engine treats <see cref="NodeIds"/> as a unit and replays it
/// <see cref="Repeat"/>.<see cref="RepeatOptions.Count"/> times, optionally mutating selected
/// fields between iterations and waiting <see cref="RepeatOptions.Delay"/> between runs.
/// </summary>
public sealed class ExecutionGroup
{
    public required string Id { get; init; }
    public string? Label { get; init; }

    /// <summary>Ids of the nodes that participate in this group.</summary>
    public IList<string> NodeIds { get; init; } = new List<string>();

    /// <summary>
    /// Optional canvas bounds (UI-only). When the UI persists a group, it stores the rectangle
    /// the user drew so it can be re-rendered as a fixed area; nodes dropped inside its bounds
    /// later are auto-added to <see cref="NodeIds"/>. Engine ignores this field.
    /// </summary>
    public GroupBounds? Bounds { get; init; }

    /// <summary>Optional UI hint: tint colour for the group's background.</summary>
    public string? BackgroundColor { get; init; }

    /// <summary>Repeat policy for the subgraph.</summary>
    public RepeatOptions Repeat { get; init; } = new();

    /// <summary>
    /// Per-iteration field overrides. Each mutation targets one node, one dot-path field, and
    /// produces its value via JSONLogic with the iteration context
    /// (<c>{ iteration, total, random, previous, groups: {...} }</c>).
    /// </summary>
    public IList<NodeMutation> Mutations { get; init; } = new List<NodeMutation>();
}

/// <summary>Canvas-space rectangle for a group. UI-only.</summary>
public sealed class GroupBounds
{
    public double X { get; init; }
    public double Y { get; init; }
    public double Width { get; init; }
    public double Height { get; init; }
}

public sealed class RepeatOptions
{
    /// <summary>How many times to run the subgraph. Defaults to <c>1</c> (no repeat).</summary>
    public int Count { get; init; } = 1;

    /// <summary>Wait between iterations. <c>null</c> = no delay.</summary>
    public TimeSpan? Delay { get; init; }
}

public sealed class NodeMutation
{
    /// <summary>Target node id; must be a member of the group's <see cref="ExecutionGroup.NodeIds"/>.</summary>
    public required string NodeId { get; init; }

    /// <summary>
    /// Dot-path into the node's request shape. Examples:
    /// <c>body.currencyId</c>, <c>body.user.email</c>, <c>pathParameters.id</c>,
    /// <c>queryParameters.page</c>, <c>headers.X-Trace-Id</c>.
    /// </summary>
    public required string Field { get; init; }

    /// <summary>JSONLogic rule producing the new value. Evaluated once per iteration with
    /// <c>{ iteration: 1..N, total: N, random: 0..1, previous: lastIterationNodes }</c>.</summary>
    public JsonNode? Rule { get; init; }
}
