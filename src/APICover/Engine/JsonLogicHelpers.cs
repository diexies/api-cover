using System.Text.Json.Nodes;
using Json.Logic;

namespace APICover.Engine;

/// <summary>
/// Helpers for working with <see cref="JsonNode"/> values that may contain JSONLogic operator
/// sub-trees mixed with literal data.
/// </summary>
internal static class JsonLogicHelpers
{
    /// <summary>
    /// True when the given node is a JSONLogic rule-object: a JsonObject with exactly one
    /// property whose name is a registered operator (either a typed rule or a handler instance).
    /// </summary>
    public static bool IsRuleObject(JsonNode? node)
    {
        if (node is not JsonObject obj || obj.Count != 1)
        {
            return false;
        }

        var key = obj.First().Key;
        return RuleRegistry.GetRule(key) is not null
            || RuleRegistry.GetHandler(key) is not null;
    }

    /// <summary>
    /// Evaluates each item of <paramref name="args"/> against <paramref name="data"/> using
    /// JSONLogic semantics. Used by custom operators to resolve their child arguments.
    /// </summary>
    public static JsonNode?[] EvaluateArgs(JsonNode? args, JsonNode? data)
    {
        if (args is JsonArray arr)
        {
            var result = new JsonNode?[arr.Count];
            for (var i = 0; i < arr.Count; i++)
            {
                result[i] = EvaluateOne(arr[i], data);
            }
            return result;
        }

        return new[] { EvaluateOne(args, data) };
    }

    private static JsonNode? EvaluateOne(JsonNode? node, JsonNode? data)
    {
        if (node is null) return null;
        // JsonLogic.Apply handles nested rules and arrays; leaves primitives alone.
        var clone = node.DeepClone();
        var dataClone = data?.DeepClone() ?? new JsonObject();
        return JsonLogic.Apply(clone, dataClone);
    }

    /// <summary>Coerces a result <see cref="JsonNode"/> to a string (null → null).</summary>
    public static string? CoerceToString(JsonNode? node) => node switch
    {
        null => null,
        JsonValue v when v.TryGetValue<string>(out var s) => s,
        _ => node.ToJsonString()
    };
}
