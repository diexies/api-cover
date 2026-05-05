using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using APICover.Discovery.Schema;

namespace APICover.Tests.Discovery;

public class JsonSchemaGeneratorTests
{
    private readonly JsonSchemaGenerator _gen = new();

    [Fact]
    public void Primitive_string_emits_string_type()
    {
        var s = _gen.Generate(typeof(string));
        Assert.Equal("string", s!["type"]!.GetValue<string>());
    }

    [Fact]
    public void Primitive_int_emits_integer_type()
    {
        var s = _gen.Generate(typeof(int));
        Assert.Equal("integer", s!["type"]!.GetValue<string>());
    }

    [Fact]
    public void Guid_emits_uuid_format()
    {
        var s = _gen.Generate(typeof(Guid));
        Assert.Equal("string", s!["type"]!.GetValue<string>());
        Assert.Equal("uuid", s["format"]!.GetValue<string>());
    }

    [Fact]
    public void Nullable_int_emits_array_type_with_null()
    {
        var s = _gen.Generate(typeof(int?));
        var types = (JsonArray)s!["type"]!;
        Assert.Contains(types, t => t!.GetValue<string>() == "integer");
        Assert.Contains(types, t => t!.GetValue<string>() == "null");
    }

    [Fact]
    public void Enum_emits_string_with_enum_array()
    {
        var s = _gen.Generate(typeof(SampleEnum));
        Assert.Equal("string", s!["type"]!.GetValue<string>());
        var values = (JsonArray)s["enum"]!;
        Assert.Equal(3, values.Count);
        Assert.Contains(values, v => v!.GetValue<string>() == "Alpha");
    }

    [Fact]
    public void Array_emits_array_with_items()
    {
        var s = _gen.Generate(typeof(int[]));
        Assert.Equal("array", s!["type"]!.GetValue<string>());
        Assert.Equal("integer", s["items"]!["type"]!.GetValue<string>());
    }

    [Fact]
    public void Dictionary_string_T_emits_additionalProperties()
    {
        var s = _gen.Generate(typeof(Dictionary<string, int>));
        Assert.Equal("object", s!["type"]!.GetValue<string>());
        Assert.Equal("integer", s["additionalProperties"]!["type"]!.GetValue<string>());
    }

    [Fact]
    public void Record_emits_object_with_camelCase_properties()
    {
        var s = _gen.Generate(typeof(SampleUser));
        Assert.Equal("object", s!["type"]!.GetValue<string>());
        var props = (JsonObject)s["properties"]!;
        Assert.True(props.ContainsKey("name"));
        Assert.True(props.ContainsKey("age"));
        Assert.Equal("string", props["name"]!["type"]!.GetValue<string>());
        Assert.Equal("integer", props["age"]!["type"]!.GetValue<string>());
    }

    [Fact]
    public void Required_value_types_appear_in_required_array()
    {
        var s = _gen.Generate(typeof(SampleUser));
        var required = (JsonArray)s!["required"]!;
        Assert.Contains(required, v => v!.GetValue<string>() == "age");
    }

    [Fact]
    public void Recursive_type_uses_dollar_ref_with_defs()
    {
        var s = _gen.Generate(typeof(Tree));
        Assert.NotNull(s!["$defs"]);
        var defs = (JsonObject)s["$defs"]!;
        Assert.True(defs.ContainsKey("Tree"));

        var props = (JsonObject)defs["Tree"]!["properties"]!;
        // children is array of Tree → items should be a $ref or anyOf wrapping a $ref.
        var items = props["children"]!["items"]!;
        var refOrAnyOf = items["$ref"] is not null
            || (items["anyOf"] is JsonArray a && a.Any(n => n?["$ref"] is not null));
        Assert.True(refOrAnyOf, $"Expected $ref in items, got: {items.ToJsonString()}");
    }

    [Fact]
    public void JsonPolymorphic_emits_oneOf()
    {
        var s = _gen.Generate(typeof(Animal));
        Assert.NotNull(s!["oneOf"]);
        var oneOf = (JsonArray)s["oneOf"]!;
        Assert.Equal(2, oneOf.Count);
    }

    [Fact]
    public void JsonNode_is_opaque()
    {
        var s = _gen.Generate(typeof(JsonNode));
        Assert.Empty((JsonObject)s!);
    }

    [Fact]
    public void Task_T_unwraps_to_T_schema()
    {
        var s = _gen.Generate(typeof(Task<int>));
        Assert.Equal("integer", s!["type"]!.GetValue<string>());
    }

    [Fact]
    public void JsonPropertyName_overrides_property_name()
    {
        var s = _gen.Generate(typeof(WithRename));
        var props = (JsonObject)s!["properties"]!;
        Assert.True(props.ContainsKey("custom_field"));
        Assert.False(props.ContainsKey("originalName"));
    }

    [Fact]
    public void JsonIgnore_skips_property()
    {
        var s = _gen.Generate(typeof(WithIgnore));
        var props = (JsonObject)s!["properties"]!;
        Assert.False(props.ContainsKey("hidden"));
    }

    public enum SampleEnum { Alpha, Beta, Gamma }

    public sealed record SampleUser(string Name, int Age);

    public sealed class Tree
    {
        public string? Label { get; init; }
        public List<Tree> Children { get; init; } = new();
    }

    [JsonPolymorphic]
    [JsonDerivedType(typeof(Dog))]
    [JsonDerivedType(typeof(Cat))]
    public abstract class Animal { public string? Name { get; init; } }
    public sealed class Dog : Animal { public bool GoodBoy { get; init; } }
    public sealed class Cat : Animal { public int Lives { get; init; } }

    public sealed class WithRename
    {
        [JsonPropertyName("custom_field")]
        public string? OriginalName { get; init; }
    }

    public sealed class WithIgnore
    {
        public string? Visible { get; init; }
        [JsonIgnore] public string? Hidden { get; init; }
    }
}
