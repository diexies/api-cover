using System.Text.Json.Nodes;
using APICover.Abstractions.Models;
using APICover.Engine;

namespace APICover.Tests.Engine;

public class JsonLogicRuleEvaluatorTests
{
    private readonly JsonLogicRuleEvaluator _evaluator = new();

    private static RunContext MakeContext()
    {
        var ctx = new RunContext
        {
            Input = (JsonObject)JsonNode.Parse("""{ "firstName": "Ada", "lastName": "Lovelace", "age": 36 }""")!,
            Env = (JsonObject)JsonNode.Parse("""{ "baseUrl": "https://example.test" }""")!,
            Nodes = (JsonObject)JsonNode.Parse("""
                {
                  "create": {
                    "request":  { "method": "POST", "path": "/users", "body": { "name": "Ada" } },
                    "response": { "status": 201, "body": { "user": { "id": 42 } } }
                  }
                }
                """)!
        };
        return ctx;
    }

    [Fact]
    public void Evaluate_returns_null_for_null_input()
    {
        Assert.Null(_evaluator.Evaluate(null, MakeContext()));
    }

    [Fact]
    public void Evaluate_passes_through_pure_literal_object()
    {
        var input = JsonNode.Parse("""{ "name": "Ada", "active": true, "tags": ["a", "b"] }""");
        var result = _evaluator.Evaluate(input, MakeContext());
        Assert.Equal(input!.ToJsonString(), result!.ToJsonString());
    }

    [Fact]
    public void Evaluate_resolves_var_at_root()
    {
        var input = JsonNode.Parse("""{ "var": "input.firstName" }""");
        var result = _evaluator.Evaluate(input, MakeContext());
        Assert.Equal("Ada", result!.GetValue<string>());
    }

    [Fact]
    public void Evaluate_resolves_var_inside_literal_object()
    {
        var input = JsonNode.Parse("""
            {
              "userId":   { "var": "nodes.create.response.body.user.id" },
              "static":   "hello"
            }
            """);

        var result = _evaluator.Evaluate(input, MakeContext()) as JsonObject;

        Assert.NotNull(result);
        Assert.Equal(42, result!["userId"]!.GetValue<int>());
        Assert.Equal("hello", result["static"]!.GetValue<string>());
    }

    [Fact]
    public void Evaluate_resolves_nested_objects_and_arrays()
    {
        var input = JsonNode.Parse("""
            {
              "items": [
                { "id": { "var": "nodes.create.response.body.user.id" } },
                { "id": 99 }
              ],
              "meta": { "by": { "var": "input.firstName" } }
            }
            """);

        var result = _evaluator.Evaluate(input, MakeContext()) as JsonObject;

        Assert.Equal(42, result!["items"]![0]!["id"]!.GetValue<int>());
        Assert.Equal(99, result["items"]![1]!["id"]!.GetValue<int>());
        Assert.Equal("Ada", result["meta"]!["by"]!.GetValue<string>());
    }

    [Fact]
    public void Evaluate_supports_cat_and_if_operators()
    {
        var input = JsonNode.Parse("""
            {
              "fullName": { "cat": [ { "var": "input.firstName" }, " ", { "var": "input.lastName" } ] },
              "isAdult":  { ">=": [ { "var": "input.age" }, 18 ] },
              "tier":     { "if": [ { ">=": [ { "var": "input.age" }, 65 ] }, "senior", "adult" ] }
            }
            """);

        var result = _evaluator.Evaluate(input, MakeContext()) as JsonObject;

        Assert.Equal("Ada Lovelace", result!["fullName"]!.GetValue<string>());
        Assert.True(result["isAdult"]!.GetValue<bool>());
        Assert.Equal("adult", result["tier"]!.GetValue<string>());
    }

    [Fact]
    public void EvaluateAsString_returns_unquoted_string_for_string_value()
    {
        var input = JsonNode.Parse("""{ "var": "input.firstName" }""");
        Assert.Equal("Ada", _evaluator.EvaluateAsString(input, MakeContext()));
    }

    [Fact]
    public void EvaluateAsString_serialises_non_string_value()
    {
        var input = JsonNode.Parse("""{ "var": "nodes.create.response.body.user.id" }""");
        Assert.Equal("42", _evaluator.EvaluateAsString(input, MakeContext()));
    }
}
