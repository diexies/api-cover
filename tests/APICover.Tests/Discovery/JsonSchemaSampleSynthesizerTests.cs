using System.Text.Json.Nodes;
using APICover.Discovery.Schema;

namespace APICover.Tests.Discovery;

public class JsonSchemaSampleSynthesizerTests
{
    private readonly JsonSchemaGenerator _gen = new();
    private readonly JsonSchemaSampleSynthesizer _syn = new();

    [Fact]
    public void String_yields_empty_string()
    {
        var sample = _syn.Synthesize(_gen.Generate(typeof(string)));
        Assert.Equal("", sample!.GetValue<string>());
    }

    [Fact]
    public void Integer_yields_zero()
    {
        var sample = _syn.Synthesize(_gen.Generate(typeof(int)));
        Assert.Equal(0, sample!.GetValue<int>());
    }

    [Fact]
    public void Guid_yields_zero_uuid()
    {
        var sample = _syn.Synthesize(_gen.Generate(typeof(Guid)));
        Assert.Equal("00000000-0000-0000-0000-000000000000", sample!.GetValue<string>());
    }

    [Fact]
    public void DateTime_yields_epoch()
    {
        var sample = _syn.Synthesize(_gen.Generate(typeof(DateTime)));
        Assert.Equal("1970-01-01T00:00:00Z", sample!.GetValue<string>());
    }

    [Fact]
    public void Array_yields_one_element()
    {
        var sample = _syn.Synthesize(_gen.Generate(typeof(int[])));
        var arr = Assert.IsType<JsonArray>(sample);
        Assert.Single(arr);
        Assert.Equal(0, arr[0]!.GetValue<int>());
    }

    [Fact]
    public void Record_yields_object_with_all_properties()
    {
        var sample = _syn.Synthesize(_gen.Generate(typeof(JsonSchemaGeneratorTests.SampleUser)));
        var obj = Assert.IsType<JsonObject>(sample);
        Assert.True(obj.ContainsKey("name"));
        Assert.True(obj.ContainsKey("age"));
        Assert.Equal("", obj["name"]!.GetValue<string>());
        Assert.Equal(0, obj["age"]!.GetValue<int>());
    }

    [Fact]
    public void Recursive_type_does_not_loop_forever()
    {
        var sample = _syn.Synthesize(_gen.Generate(typeof(JsonSchemaGeneratorTests.Tree)));
        Assert.NotNull(sample);
        // Should produce some object with label and children fields.
        var obj = Assert.IsType<JsonObject>(sample);
        Assert.True(obj.ContainsKey("label"));
    }

    [Fact]
    public void Enum_yields_first_value()
    {
        var sample = _syn.Synthesize(_gen.Generate(typeof(JsonSchemaGeneratorTests.SampleEnum)));
        Assert.Equal("Alpha", sample!.GetValue<string>());
    }
}
