using System.Text.Json.Nodes;
using Json.Logic;
using APICover.Abstractions.Models;
using APICover.Abstractions.Services;

namespace APICover.Engine;

/// <summary>
/// Default <see cref="IRuleEvaluator"/> implementation backed by the JsonEverything
/// <c>JsonLogic</c> package. Walks a <see cref="JsonNode"/> tree and evaluates only the
/// sub-trees that look like JSONLogic rule-objects (<see cref="JsonLogicHelpers.IsRuleObject"/>),
/// leaving literal JSON intact. This enables request body / header / parameter templates that
/// mix static structure with dynamic <c>{ "var": ... }</c> sub-expressions.
/// </summary>
public sealed class JsonLogicRuleEvaluator : IRuleEvaluator
{
    /// <summary>Static constructor registers Utopia custom operators exactly once.</summary>
    static JsonLogicRuleEvaluator()
    {
        Operators.APICoverOperators.RegisterAll();
    }

    public JsonNode? Evaluate(JsonNode? value, RunContext context)
    {
        ArgumentNullException.ThrowIfNull(context);
        if (value is null) return null;

        var data = context.ToJson();
        return EvaluateNode(value, data);
    }

    public string? EvaluateAsString(JsonNode? value, RunContext context) =>
        JsonLogicHelpers.CoerceToString(Evaluate(value, context));

    public bool EvaluateAsBoolean(JsonNode? value, RunContext context)
    {
        var result = Evaluate(value, context);
        return result switch
        {
            null => false,
            JsonValue v when v.TryGetValue<bool>(out var b) => b,
            JsonValue v when v.TryGetValue<string>(out var s) => !string.IsNullOrEmpty(s),
            JsonValue v when v.TryGetValue<double>(out var d) => d != 0,
            JsonValue v when v.TryGetValue<int>(out var i) => i != 0,
            JsonValue v when v.TryGetValue<long>(out var l) => l != 0,
            JsonArray a => a.Count > 0,
            JsonObject o => o.Count > 0,
            _ => true
        };
    }

    private static JsonNode? EvaluateNode(JsonNode? node, JsonNode data)
    {
        if (node is null) return null;

        // Rule-object: the whole sub-tree is a JSONLogic rule, hand it to the engine as-is.
        if (JsonLogicHelpers.IsRuleObject(node))
        {
            var ruleClone = node.DeepClone();
            var dataClone = data.DeepClone();
            var result = JsonLogic.Apply(ruleClone, dataClone);
            // Detach from any parent the engine may have left attached so it can be re-parented.
            return result?.DeepClone();
        }

        return node switch
        {
            JsonObject obj => EvaluateObject(obj, data),
            JsonArray arr => EvaluateArray(arr, data),
            _ => node.DeepClone()
        };
    }

    private static JsonObject EvaluateObject(JsonObject obj, JsonNode data)
    {
        var result = new JsonObject();
        foreach (var (key, child) in obj)
        {
            result[key] = EvaluateNode(child, data);
        }
        return result;
    }

    private static JsonArray EvaluateArray(JsonArray arr, JsonNode data)
    {
        var result = new JsonArray();
        foreach (var child in arr)
        {
            result.Add(EvaluateNode(child, data));
        }
        return result;
    }
}
