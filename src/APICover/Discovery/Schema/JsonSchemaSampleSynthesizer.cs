using System.Text.Json.Nodes;

namespace APICover.Discovery.Schema;

/// <summary>
/// Walks a JSON Schema produced by <see cref="JsonSchemaGenerator"/> and produces a plausible
/// example payload (zeros, empty strings, single-element arrays, populated objects). Used to
/// give the inspector UI a starting body for endpoints that don't ship an explicit sample.
/// </summary>
public sealed class JsonSchemaSampleSynthesizer
{
    public JsonNode? Synthesize(JsonNode? schema)
    {
        if (schema is null) return null;
        var defs = ExtractDefs(schema);
        return Synthesize(schema, defs, depth: 0);
    }

    private JsonNode? Synthesize(JsonNode? schema, IReadOnlyDictionary<string, JsonNode> defs, int depth)
    {
        if (schema is not JsonObject obj || depth > 16) return null;

        if (obj["$ref"] is JsonValue refValue && refValue.TryGetValue<string>(out var refPath))
        {
            var key = refPath.StartsWith("#/$defs/", StringComparison.Ordinal) ? refPath["#/$defs/".Length..] : null;
            if (key is not null && defs.TryGetValue(key, out var target))
            {
                return Synthesize(target, defs, depth + 1);
            }
            return null;
        }

        if (obj["anyOf"] is JsonArray anyOf && anyOf.Count > 0)
        {
            return Synthesize(anyOf[0], defs, depth + 1);
        }
        if (obj["oneOf"] is JsonArray oneOf && oneOf.Count > 0)
        {
            return Synthesize(oneOf[0], defs, depth + 1);
        }

        if (obj["enum"] is JsonArray enumValues && enumValues.Count > 0)
        {
            return enumValues[0]?.DeepClone();
        }

        var typeNode = obj["type"];
        var primary = typeNode switch
        {
            JsonValue v when v.TryGetValue<string>(out var t) => t,
            JsonArray arr => arr.OfType<JsonValue>().Select(v => v.TryGetValue<string>(out var s) ? s : null)
                                .FirstOrDefault(s => s != "null") ?? "null",
            _ => null
        };

        return primary switch
        {
            "string" => SynthesizeString(obj),
            "integer" => JsonValue.Create(0),
            "number" => JsonValue.Create(0),
            "boolean" => JsonValue.Create(false),
            "array" => new JsonArray(Synthesize(obj["items"], defs, depth + 1) ?? new JsonObject()),
            "object" => SynthesizeObject(obj, defs, depth),
            "null" => null,
            _ => obj["properties"] is JsonObject ? SynthesizeObject(obj, defs, depth) : new JsonObject()
        };
    }

    private static JsonNode SynthesizeString(JsonObject obj)
    {
        if (obj["format"] is JsonValue fmt && fmt.TryGetValue<string>(out var format))
        {
            return format switch
            {
                "uuid" => JsonValue.Create("00000000-0000-0000-0000-000000000000"),
                "date-time" => JsonValue.Create("1970-01-01T00:00:00Z"),
                "date" => JsonValue.Create("1970-01-01"),
                "time" => JsonValue.Create("00:00:00"),
                "duration" => JsonValue.Create("PT0S"),
                "uri" => JsonValue.Create("https://example.com"),
                "byte" => JsonValue.Create(""),
                _ => JsonValue.Create("")
            };
        }
        return JsonValue.Create("")!;
    }

    private JsonNode SynthesizeObject(JsonObject obj, IReadOnlyDictionary<string, JsonNode> defs, int depth)
    {
        var result = new JsonObject();
        if (obj["properties"] is JsonObject props)
        {
            foreach (var (name, node) in props)
            {
                result[name] = Synthesize(node, defs, depth + 1);
            }
        }
        return result;
    }

    private static IReadOnlyDictionary<string, JsonNode> ExtractDefs(JsonNode schema)
    {
        if (schema is JsonObject obj && obj["$defs"] is JsonObject defsObj)
        {
            var dict = new Dictionary<string, JsonNode>(StringComparer.Ordinal);
            foreach (var (k, v) in defsObj)
            {
                if (v is not null) dict[k] = v;
            }
            return dict;
        }
        return new Dictionary<string, JsonNode>();
    }
}
