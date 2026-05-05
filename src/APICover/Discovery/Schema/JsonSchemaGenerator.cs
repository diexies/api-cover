using System.Collections;
using System.Reflection;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace APICover.Discovery.Schema;

/// <summary>
/// Reflection-based JSON Schema (Draft 2020-12 subset) generator. Intentionally minimal:
/// covers primitives, nullable, enums, collections, dictionaries, records / classes (with
/// recursion via <c>$defs</c>), and best-effort polymorphism. Opaque types fall back to
/// <c>{}</c> rather than throwing — discovery never fails on an unsupported type.
/// </summary>
public sealed class JsonSchemaGenerator
{
    /// <summary>Builds a JSON Schema for the given CLR type. Returns <c>null</c> if <paramref name="type"/>
    /// is <c>void</c> or otherwise non-meaningful.</summary>
    public JsonNode? Generate(Type type)
    {
        ArgumentNullException.ThrowIfNull(type);
        if (type == typeof(void)) return null;

        var defs = new Dictionary<string, JsonNode>(StringComparer.Ordinal);
        var stack = new Stack<Type>();
        var schema = BuildSchema(type, defs, stack);

        if (defs.Count > 0 && schema is JsonObject obj)
        {
            var defsNode = new JsonObject();
            foreach (var (name, def) in defs)
            {
                defsNode[name] = def;
            }
            obj["$defs"] = defsNode;
        }

        return schema;
    }

    private JsonNode BuildSchema(Type type, IDictionary<string, JsonNode> defs, Stack<Type> stack)
    {
        // Unwrap Task<T> / ValueTask<T> for response-type cases.
        if (type.IsGenericType)
        {
            var def = type.GetGenericTypeDefinition();
            if (def == typeof(Task<>) || def == typeof(ValueTask<>))
            {
                return BuildSchema(type.GetGenericArguments()[0], defs, stack);
            }
        }

        // Nullable<T> → underlying + nullable
        var underlying = Nullable.GetUnderlyingType(type);
        if (underlying is not null)
        {
            var inner = BuildSchema(underlying, defs, stack);
            MarkNullable(inner);
            return inner;
        }

        // Primitives & well-known
        if (TryPrimitive(type, out var primitive))
        {
            return primitive!;
        }

        // Enum
        if (type.IsEnum)
        {
            var enumNode = new JsonObject { ["type"] = "string" };
            var values = new JsonArray();
            foreach (var name in Enum.GetNames(type))
            {
                values.Add(name);
            }
            enumNode["enum"] = values;
            return enumNode;
        }

        // Dictionary<string, T>
        if (TryDictionary(type, out var valueType))
        {
            return new JsonObject
            {
                ["type"] = "object",
                ["additionalProperties"] = BuildSchema(valueType!, defs, stack)
            };
        }

        // IEnumerable<T> (excluding string, already handled)
        if (TryEnumerable(type, out var elementType))
        {
            return new JsonObject
            {
                ["type"] = "array",
                ["items"] = BuildSchema(elementType!, defs, stack)
            };
        }

        // Polymorphic root: emit oneOf when [JsonPolymorphic] declared.
        var polymorphic = type.GetCustomAttribute<JsonPolymorphicAttribute>();
        if (polymorphic is not null)
        {
            var derived = type.GetCustomAttributes<JsonDerivedTypeAttribute>().ToList();
            if (derived.Count > 0)
            {
                var oneOf = new JsonArray();
                foreach (var dt in derived)
                {
                    oneOf.Add(BuildObjectSchema(dt.DerivedType, defs, stack));
                }
                return new JsonObject { ["oneOf"] = oneOf };
            }
        }

        // Object (class / record / struct)
        return BuildObjectSchema(type, defs, stack);
    }

    private JsonNode BuildObjectSchema(Type type, IDictionary<string, JsonNode> defs, Stack<Type> stack)
    {
        // Opaque: JsonNode/JsonElement/object — emit empty schema.
        if (type == typeof(JsonNode) || type == typeof(JsonObject) || type == typeof(JsonArray)
            || type == typeof(JsonValue) || type.FullName == "System.Text.Json.JsonElement"
            || type == typeof(object))
        {
            return new JsonObject();
        }

        var key = DefName(type);

        // Recursion guard: emit $ref if the type is currently being built or already defined.
        if (stack.Contains(type) || defs.ContainsKey(key))
        {
            // Ensure a placeholder exists if we're about to recurse before completing it.
            defs.TryAdd(key, new JsonObject());
            return new JsonObject { ["$ref"] = $"#/$defs/{key}" };
        }

        stack.Push(type);
        try
        {
            var properties = new JsonObject();
            var required = new JsonArray();

            var nullCtx = new NullabilityInfoContext();

            foreach (var prop in type.GetProperties(BindingFlags.Instance | BindingFlags.Public))
            {
                if (prop.GetIndexParameters().Length > 0) continue;
                if (prop.GetCustomAttribute<JsonIgnoreAttribute>() is not null) continue;

                var name = prop.GetCustomAttribute<JsonPropertyNameAttribute>()?.Name ?? CamelCase(prop.Name);
                var propSchema = BuildSchema(prop.PropertyType, defs, stack);

                NullabilityInfo? info = null;
                try { info = nullCtx.Create(prop); } catch { /* generic type params can throw */ }

                if (info is { ReadState: NullabilityState.Nullable } || Nullable.GetUnderlyingType(prop.PropertyType) is not null)
                {
                    MarkNullable(propSchema);
                }

                properties[name] = propSchema;

                var isRequired = IsRequiredProperty(prop, info);
                if (isRequired) required.Add(name);
            }

            var obj = new JsonObject
            {
                ["type"] = "object",
                ["properties"] = properties
            };
            if (required.Count > 0) obj["required"] = required;

            // Was a recursive reference seeded? If so, complete the definition.
            if (defs.ContainsKey(key))
            {
                defs[key] = obj;
                return new JsonObject { ["$ref"] = $"#/$defs/{key}" };
            }

            return obj;
        }
        finally
        {
            stack.Pop();
        }
    }

    private static bool IsRequiredProperty(PropertyInfo prop, NullabilityInfo? info)
    {
        if (prop.GetCustomAttribute(typeof(System.Runtime.CompilerServices.RequiredMemberAttribute)) is not null)
        {
            return true;
        }
        if (prop.GetCustomAttribute<JsonRequiredAttribute>() is not null) return true;
        if (info is { WriteState: NullabilityState.NotNull } && Nullable.GetUnderlyingType(prop.PropertyType) is null
            && prop.PropertyType.IsValueType is false)
        {
            // Non-nullable reference type — treat as required for schema documentation purposes.
            return true;
        }
        if (prop.PropertyType.IsValueType && Nullable.GetUnderlyingType(prop.PropertyType) is null)
        {
            return true;
        }
        return false;
    }

    private static bool TryPrimitive(Type type, out JsonNode? schema)
    {
        schema = type switch
        {
            _ when type == typeof(string) => new JsonObject { ["type"] = "string" },
            _ when type == typeof(bool) => new JsonObject { ["type"] = "boolean" },
            _ when type == typeof(byte) || type == typeof(sbyte)
                || type == typeof(short) || type == typeof(ushort)
                || type == typeof(int) || type == typeof(uint)
                || type == typeof(long) || type == typeof(ulong)
                => new JsonObject { ["type"] = "integer" },
            _ when type == typeof(float) || type == typeof(double) || type == typeof(decimal)
                => new JsonObject { ["type"] = "number" },
            _ when type == typeof(Guid) => new JsonObject { ["type"] = "string", ["format"] = "uuid" },
            _ when type == typeof(DateTime) || type == typeof(DateTimeOffset)
                => new JsonObject { ["type"] = "string", ["format"] = "date-time" },
            _ when type == typeof(DateOnly) => new JsonObject { ["type"] = "string", ["format"] = "date" },
            _ when type == typeof(TimeOnly) => new JsonObject { ["type"] = "string", ["format"] = "time" },
            _ when type == typeof(TimeSpan) => new JsonObject { ["type"] = "string", ["format"] = "duration" },
            _ when type == typeof(Uri) => new JsonObject { ["type"] = "string", ["format"] = "uri" },
            _ when type == typeof(byte[]) => new JsonObject { ["type"] = "string", ["format"] = "byte" },
            _ when type == typeof(char) => new JsonObject { ["type"] = "string" },
            _ => null
        };
        return schema is not null;
    }

    private static bool TryDictionary(Type type, out Type? valueType)
    {
        foreach (var iface in type.GetInterfaces().Concat(new[] { type }))
        {
            if (iface.IsGenericType && iface.GetGenericTypeDefinition() == typeof(IDictionary<,>))
            {
                var args = iface.GetGenericArguments();
                if (args[0] == typeof(string))
                {
                    valueType = args[1];
                    return true;
                }
            }
        }
        valueType = null;
        return false;
    }

    private static bool TryEnumerable(Type type, out Type? elementType)
    {
        if (type == typeof(string))
        {
            elementType = null;
            return false;
        }
        if (type.IsArray)
        {
            elementType = type.GetElementType();
            return elementType is not null;
        }
        foreach (var iface in type.GetInterfaces().Concat(new[] { type }))
        {
            if (iface.IsGenericType && iface.GetGenericTypeDefinition() == typeof(IEnumerable<>))
            {
                elementType = iface.GetGenericArguments()[0];
                return true;
            }
        }
        if (typeof(IEnumerable).IsAssignableFrom(type))
        {
            elementType = typeof(object);
            return true;
        }
        elementType = null;
        return false;
    }

    private static void MarkNullable(JsonNode? node)
    {
        if (node is not JsonObject obj) return;
        if (obj["type"] is JsonValue v && v.TryGetValue<string>(out var t))
        {
            obj["type"] = new JsonArray(t, "null");
        }
        else if (obj["$ref"] is not null)
        {
            // JSON Schema 2020-12 doesn't allow type alongside $ref; wrap with anyOf.
            var refNode = obj["$ref"]!.DeepClone();
            obj.Remove("$ref");
            obj["anyOf"] = new JsonArray(new JsonObject { ["$ref"] = refNode }, new JsonObject { ["type"] = "null" });
        }
    }

    private static string DefName(Type type)
    {
        if (!type.IsGenericType) return type.Name;
        var name = type.Name;
        var tick = name.IndexOf('`');
        if (tick >= 0) name = name[..tick];
        var args = string.Join("_", type.GetGenericArguments().Select(DefName));
        return $"{name}_{args}";
    }

    private static string CamelCase(string name)
    {
        if (string.IsNullOrEmpty(name) || char.IsLower(name[0])) return name;
        return char.ToLowerInvariant(name[0]) + name[1..];
    }
}
