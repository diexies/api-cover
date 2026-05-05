using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Json.Logic;
using Json.Path;

namespace APICover.Engine.Operators;

/// <summary>Registers Utopia's custom JSONLogic operators with <see cref="RuleRegistry"/>.</summary>
internal static class APICoverOperators
{
    private static int _registered;

    public static void RegisterAll()
    {
        if (Interlocked.Exchange(ref _registered, 1) == 1) return;

        RuleRegistry.AddRule("regex_match", new RegexMatchRule());
        RuleRegistry.AddRule("regex_replace", new RegexReplaceRule());
        RuleRegistry.AddRule("to_upper", new ToUpperRule());
        RuleRegistry.AddRule("to_lower", new ToLowerRule());
        RuleRegistry.AddRule("uuid", new UuidRule());
        RuleRegistry.AddRule("now", new NowRule());
        RuleRegistry.AddRule("base64_encode", new Base64EncodeRule());
        RuleRegistry.AddRule("base64_decode", new Base64DecodeRule());
        RuleRegistry.AddRule("jsonpath", new JsonPathRule());
    }

    private static string? AsString(JsonNode? n) => n switch
    {
        null => null,
        JsonValue v when v.TryGetValue<string>(out var s) => s,
        _ => n.ToJsonString()
    };

    /// <summary>
    /// <c>{ "regex_match": [ &lt;pattern&gt;, &lt;input&gt; ] }</c> → boolean.
    /// </summary>
    private sealed class RegexMatchRule : IRule
    {
        public JsonNode? Apply(JsonNode? args, EvaluationContext context)
        {
            var resolved = JsonLogicHelpers.EvaluateArgs(args, context.CurrentValue);
            if (resolved.Length < 2) return JsonValue.Create(false);
            var pattern = AsString(resolved[0]) ?? string.Empty;
            var input = AsString(resolved[1]) ?? string.Empty;
            return JsonValue.Create(Regex.IsMatch(input, pattern));
        }
    }

    /// <summary>
    /// <c>{ "regex_replace": [ &lt;pattern&gt;, &lt;replacement&gt;, &lt;input&gt; ] }</c> → string.
    /// </summary>
    private sealed class RegexReplaceRule : IRule
    {
        public JsonNode? Apply(JsonNode? args, EvaluationContext context)
        {
            var resolved = JsonLogicHelpers.EvaluateArgs(args, context.CurrentValue);
            if (resolved.Length < 3) return JsonValue.Create(string.Empty);
            var pattern = AsString(resolved[0]) ?? string.Empty;
            var replacement = AsString(resolved[1]) ?? string.Empty;
            var input = AsString(resolved[2]) ?? string.Empty;
            return JsonValue.Create(Regex.Replace(input, pattern, replacement));
        }
    }

    private sealed class ToUpperRule : IRule
    {
        public JsonNode? Apply(JsonNode? args, EvaluationContext context)
        {
            var resolved = JsonLogicHelpers.EvaluateArgs(args, context.CurrentValue);
            return JsonValue.Create((AsString(resolved.FirstOrDefault()) ?? string.Empty).ToUpperInvariant());
        }
    }

    private sealed class ToLowerRule : IRule
    {
        public JsonNode? Apply(JsonNode? args, EvaluationContext context)
        {
            var resolved = JsonLogicHelpers.EvaluateArgs(args, context.CurrentValue);
            return JsonValue.Create((AsString(resolved.FirstOrDefault()) ?? string.Empty).ToLowerInvariant());
        }
    }

    /// <summary><c>{ "uuid": [] }</c> → newly generated GUID string.</summary>
    private sealed class UuidRule : IRule
    {
        public JsonNode? Apply(JsonNode? args, EvaluationContext context) =>
            JsonValue.Create(Guid.NewGuid().ToString());
    }

    /// <summary>
    /// <c>{ "now": [] }</c> or <c>{ "now": [ &lt;format&gt; ] }</c> → ISO-8601 UTC timestamp by
    /// default, or formatted with the given <see cref="DateTimeOffset"/> format string.
    /// </summary>
    private sealed class NowRule : IRule
    {
        public JsonNode? Apply(JsonNode? args, EvaluationContext context)
        {
            var resolved = JsonLogicHelpers.EvaluateArgs(args, context.CurrentValue);
            var format = AsString(resolved.FirstOrDefault());
            var now = DateTimeOffset.UtcNow;
            return JsonValue.Create(string.IsNullOrEmpty(format)
                ? now.ToString("O")
                : now.ToString(format, System.Globalization.CultureInfo.InvariantCulture));
        }
    }

    private sealed class Base64EncodeRule : IRule
    {
        public JsonNode? Apply(JsonNode? args, EvaluationContext context)
        {
            var resolved = JsonLogicHelpers.EvaluateArgs(args, context.CurrentValue);
            var input = AsString(resolved.FirstOrDefault()) ?? string.Empty;
            return JsonValue.Create(Convert.ToBase64String(Encoding.UTF8.GetBytes(input)));
        }
    }

    private sealed class Base64DecodeRule : IRule
    {
        public JsonNode? Apply(JsonNode? args, EvaluationContext context)
        {
            var resolved = JsonLogicHelpers.EvaluateArgs(args, context.CurrentValue);
            var input = AsString(resolved.FirstOrDefault()) ?? string.Empty;
            try
            {
                return JsonValue.Create(Encoding.UTF8.GetString(Convert.FromBase64String(input)));
            }
            catch (FormatException)
            {
                return null;
            }
        }
    }

    /// <summary>
    /// <c>{ "jsonpath": [ &lt;path&gt; ] }</c> → first match of the JSONPath against the current
    /// data scope, or <c>{ "jsonpath": [ &lt;path&gt;, &lt;source&gt; ] }</c> against an explicit JSON value.
    /// </summary>
    private sealed class JsonPathRule : IRule
    {
        public JsonNode? Apply(JsonNode? args, EvaluationContext context)
        {
            var resolved = JsonLogicHelpers.EvaluateArgs(args, context.CurrentValue);
            if (resolved.Length == 0) return null;

            var pathStr = AsString(resolved[0]);
            if (string.IsNullOrEmpty(pathStr)) return null;

            JsonNode? source = resolved.Length > 1 ? resolved[1] : context.CurrentValue;
            if (!JsonPath.TryParse(pathStr, out var path)) return null;

            var matches = path.Evaluate(source).Matches;
            if (matches is null || matches.Count == 0) return null;
            if (matches.Count == 1) return matches[0].Value?.DeepClone();

            var arr = new JsonArray();
            foreach (var m in matches)
            {
                arr.Add(m.Value?.DeepClone());
            }
            return arr;
        }
    }
}
