using System.Text.Json.Nodes;
using APICover.Abstractions.Models;

namespace APICover.Abstractions.Services;

/// <summary>
/// Evaluates JSON values that may contain embedded JSONLogic operator sub-trees against a
/// <see cref="RunContext"/>. Pure literal JSON is returned as-is; only sub-trees that are
/// recognised JSONLogic operators are evaluated.
/// </summary>
public interface IRuleEvaluator
{
    /// <summary>
    /// Evaluates <paramref name="value"/> against <paramref name="context"/> and returns the
    /// resolved JSON. Returns <c>null</c> when the input is <c>null</c>.
    /// </summary>
    JsonNode? Evaluate(JsonNode? value, RunContext context);

    /// <summary>
    /// Evaluates <paramref name="value"/> and coerces the result to a string. Used for header,
    /// path and query parameter values.
    /// </summary>
    string? EvaluateAsString(JsonNode? value, RunContext context);

    /// <summary>
    /// Evaluates <paramref name="value"/> and coerces the result to a boolean using JSONLogic's
    /// truthiness rules. Used by streaming-node <c>until</c> predicates.
    /// </summary>
    bool EvaluateAsBoolean(JsonNode? value, RunContext context);
}
