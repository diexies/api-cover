using System.Text.Json.Nodes;

namespace APICover.Abstractions.Models;

/// <summary>
/// A branching point in a scenario. Attached to a single anchor node, it forks the run into
/// N parallel branches at execution time — one per <see cref="CaseVariant"/>. Each variant
/// applies its own request-field overrides to the anchor; the downstream subtree is then
/// deep-cloned per branch and continues independently. Nesting is multiplicative.
/// </summary>
public sealed class CaseSet
{
    /// <summary>Stable id within the scenario.</summary>
    public required string Id { get; init; }

    /// <summary>Optional human-readable label shown in the UI.</summary>
    public string? Label { get; init; }

    /// <summary>The single node where the fork occurs. Must reference an existing
    /// <see cref="ApiNode.Id"/> in the parent scenario.</summary>
    public required string AnchorNodeId { get; init; }

    /// <summary>The branch variants. Empty list ≡ no fork.</summary>
    public IList<CaseVariant> Variants { get; init; } = new List<CaseVariant>();

    /// <summary>Optional UI hint: tint colour for the anchor badge.</summary>
    public string? BackgroundColor { get; init; }
}

/// <summary>A single branch alternative inside a <see cref="CaseSet"/>.</summary>
public sealed class CaseVariant
{
    /// <summary>Stable variant id; appears in <see cref="NodeResult.BranchPath"/> segments.</summary>
    public required string Id { get; init; }

    /// <summary>Human-readable label (e.g. "valid email", "expired token").</summary>
    public required string Label { get; init; }

    /// <summary>Per-variant request field overrides applied to the anchor before it sends.</summary>
    public IList<NodeFieldOverride> Overrides { get; init; } = new List<NodeFieldOverride>();
}

/// <summary>One field override applied to the anchor's request when a variant runs.</summary>
public sealed class NodeFieldOverride
{
    /// <summary>Dot-path against the request shape: <c>body.email</c>, <c>headers.X-Auth</c>,
    /// <c>pathParameters.id</c>, <c>queryParameters.token</c>.</summary>
    public required string Field { get; init; }

    /// <summary>Replacement value. Literal JSON when <see cref="IsRule"/> is false; a JSONLogic
    /// rule evaluated against the run context when true.</summary>
    public JsonNode? Value { get; init; }

    /// <summary>True ⇒ <see cref="Value"/> is a JSONLogic rule. False ⇒ literal.</summary>
    public bool IsRule { get; init; }
}

/// <summary>
/// Identifies a single branch within a forked run. Segments are <see cref="CaseVariant.Id"/>
/// values in the order their <see cref="CaseSet"/>s were encountered along the execution path.
/// Empty ≡ root (un-forked) branch.
/// </summary>
public readonly record struct BranchPath(IReadOnlyList<string> Segments)
{
    /// <summary>The root branch (no fork yet).</summary>
    public static BranchPath Root => new(Array.Empty<string>());

    /// <summary>Wire-format key (e.g. "v1/v2"). Empty string for root.</summary>
    public string Key => Segments.Count == 0 ? string.Empty : string.Join("/", Segments);

    /// <summary>Returns a new path with <paramref name="variantId"/> appended.</summary>
    public BranchPath Append(string variantId)
    {
        var next = new string[Segments.Count + 1];
        for (var i = 0; i < Segments.Count; i++) next[i] = Segments[i];
        next[^1] = variantId;
        return new BranchPath(next);
    }

    /// <summary>Build a path from a possibly-null list (treats null as root).</summary>
    public static BranchPath From(IReadOnlyList<string>? segments) =>
        segments is null || segments.Count == 0 ? Root : new BranchPath(segments);
}
