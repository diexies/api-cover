using System.Text.Json.Nodes;
using APICover.Abstractions.Models;
using APICover.Engine;

namespace APICover.Tests.Engine;

public class CustomOperatorTests
{
    private readonly JsonLogicRuleEvaluator _evaluator = new();

    private static RunContext Ctx() => new()
    {
        Input = (JsonObject)JsonNode.Parse("""{ "name": "Ada Lovelace", "email": "ada@example.test" }""")!
    };

    [Fact]
    public void to_upper_uppercases_string()
    {
        var result = _evaluator.Evaluate(JsonNode.Parse("""{ "to_upper": [ { "var": "input.name" } ] }"""), Ctx());
        Assert.Equal("ADA LOVELACE", result!.GetValue<string>());
    }

    [Fact]
    public void to_lower_lowercases_string()
    {
        var result = _evaluator.Evaluate(JsonNode.Parse("""{ "to_lower": "HELLO" }"""), Ctx());
        Assert.Equal("hello", result!.GetValue<string>());
    }

    [Fact]
    public void regex_match_returns_boolean()
    {
        var rule = JsonNode.Parse("""{ "regex_match": [ "^ada@", { "var": "input.email" } ] }""");
        Assert.True(_evaluator.Evaluate(rule, Ctx())!.GetValue<bool>());

        var rule2 = JsonNode.Parse("""{ "regex_match": [ "^bob@", { "var": "input.email" } ] }""");
        Assert.False(_evaluator.Evaluate(rule2, Ctx())!.GetValue<bool>());
    }

    [Fact]
    public void regex_replace_replaces_pattern()
    {
        var rule = JsonNode.Parse("""{ "regex_replace": [ "\\s+", "_", { "var": "input.name" } ] }""");
        Assert.Equal("Ada_Lovelace", _evaluator.Evaluate(rule, Ctx())!.GetValue<string>());
    }

    [Fact]
    public void uuid_returns_parseable_guid()
    {
        var result = _evaluator.Evaluate(JsonNode.Parse("""{ "uuid": [] }"""), Ctx());
        Assert.True(Guid.TryParse(result!.GetValue<string>(), out _));
    }

    [Fact]
    public void now_default_format_is_iso8601_utc()
    {
        var result = _evaluator.Evaluate(JsonNode.Parse("""{ "now": [] }"""), Ctx());
        var ts = DateTimeOffset.Parse(result!.GetValue<string>());
        Assert.True((DateTimeOffset.UtcNow - ts).Duration() < TimeSpan.FromSeconds(5));
    }

    [Fact]
    public void now_with_format_string()
    {
        var result = _evaluator.Evaluate(JsonNode.Parse("""{ "now": [ "yyyy" ] }"""), Ctx());
        Assert.Equal(DateTimeOffset.UtcNow.Year.ToString(), result!.GetValue<string>());
    }

    [Fact]
    public void base64_encode_then_decode_roundtrips()
    {
        var enc = _evaluator.Evaluate(JsonNode.Parse("""{ "base64_encode": "hello" }"""), Ctx());
        Assert.Equal("aGVsbG8=", enc!.GetValue<string>());
        var dec = _evaluator.Evaluate(JsonNode.Parse($$"""{ "base64_decode": "{{enc.GetValue<string>()}}" }"""), Ctx());
        Assert.Equal("hello", dec!.GetValue<string>());
    }

    [Fact]
    public void jsonpath_extracts_value_from_explicit_source()
    {
        var ctx = new RunContext
        {
            Input = (JsonObject)JsonNode.Parse("""
                {
                  "users": [ { "name": "Ada", "id": 1 }, { "name": "Bob", "id": 2 } ]
                }
                """)!
        };
        var rule = JsonNode.Parse("""{ "jsonpath": [ "$.users[1].id", { "var": "input" } ] }""");
        var result = _evaluator.Evaluate(rule, ctx);
        Assert.Equal(2, result!.GetValue<int>());
    }
}
