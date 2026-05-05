using System.Text.Json.Nodes;

namespace APICover.Abstractions.Models;

/// <summary>
/// Live execution context passed to the JSONLogic evaluator. Shape:
/// <code>
/// {
///   "input": { ... },
///   "env":   { ... },
///   "nodes": {
///     "&lt;nodeId&gt;": {
///       "request":  { method, path, headers, body },
///       "response": { status, headers, body }
///     }
///   }
/// }
/// </code>
/// </summary>
public sealed class RunContext
{
    /// <summary>Initial input supplied when the run was started.</summary>
    public JsonObject Input { get; init; } = new();

    /// <summary>Environment / configuration values exposed to rules.</summary>
    public JsonObject Env { get; init; } = new();

    /// <summary>Per-node request+response state, keyed by node id.</summary>
    public JsonObject Nodes { get; init; } = new();

    /// <summary>Returns a single root <see cref="JsonObject"/> suitable for JSONLogic evaluation.</summary>
    public JsonObject ToJson() => new()
    {
        ["input"] = Input.DeepClone(),
        ["env"] = Env.DeepClone(),
        ["nodes"] = Nodes.DeepClone()
    };

    /// <summary>
    /// Returns a deep-cloned <see cref="RunContext"/>. Used by the engine when a CaseSet
    /// anchor forks the run — each branch keeps its own context so downstream node responses
    /// don't bleed across branches.
    /// </summary>
    public RunContext Clone() => new()
    {
        Input = (JsonObject)Input.DeepClone(),
        Env = (JsonObject)Env.DeepClone(),
        Nodes = (JsonObject)Nodes.DeepClone()
    };
}
