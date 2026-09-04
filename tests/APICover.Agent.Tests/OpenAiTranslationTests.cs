using System.Text.Json.Nodes;
using APICover.Agent.Anthropic;
using APICover.Agent.OpenAi;

namespace APICover.Agent.Tests;

public class OpenAiTranslationTests
{
    [Fact]
    public void ToOpenAiPayload_MapsSystemToolsAndConversation()
    {
        var request = new MessageRequest
        {
            Model = "claude-opus-ignored",
            MaxTokens = 4096,
            System = "You are the APICover agent.",
            Messages = new[]
            {
                new Message { Role = "user", Content = new[] { ContentBlock.TextBlock("scan the system") } },
                new Message
                {
                    Role = "assistant",
                    Content = new[]
                    {
                        ContentBlock.TextBlock("Listing endpoints first."),
                        new ContentBlock { Type = "tool_use", Id = "call_1", Name = "list_endpoints", Input = JsonNode.Parse("""{"area":"user"}""") },
                    }
                },
                new Message
                {
                    Role = "user",
                    Content = new[] { ContentBlock.ToolResultBlock("call_1", JsonNode.Parse("""{"count":3}""")) }
                },
            },
            Tools = new[]
            {
                new ToolDefinition
                {
                    Name = "list_endpoints",
                    Description = "List endpoints",
                    InputSchema = JsonNode.Parse("""{"type":"object"}""")!,
                }
            },
        };

        var payload = OpenAiHttpClient.ToOpenAiPayload(request, "gpt-5-codex");

        Assert.Equal("gpt-5-codex", payload["model"]!.GetValue<string>());
        Assert.Equal(4096, payload["max_completion_tokens"]!.GetValue<int>());

        var messages = payload["messages"]!.AsArray();
        Assert.Equal("system", messages[0]!["role"]!.GetValue<string>());
        Assert.Equal("user", messages[1]!["role"]!.GetValue<string>());

        var assistant = messages[2]!;
        Assert.Equal("assistant", assistant["role"]!.GetValue<string>());
        Assert.Equal("Listing endpoints first.", assistant["content"]!.GetValue<string>());
        var call = assistant["tool_calls"]!.AsArray()[0]!;
        Assert.Equal("call_1", call["id"]!.GetValue<string>());
        Assert.Equal("list_endpoints", call["function"]!["name"]!.GetValue<string>());
        Assert.Contains("\"area\"", call["function"]!["arguments"]!.GetValue<string>());

        var toolMsg = messages[3]!;
        Assert.Equal("tool", toolMsg["role"]!.GetValue<string>());
        Assert.Equal("call_1", toolMsg["tool_call_id"]!.GetValue<string>());
        Assert.Contains("\"count\"", toolMsg["content"]!.GetValue<string>());

        var tool = payload["tools"]!.AsArray()[0]!;
        Assert.Equal("function", tool["type"]!.GetValue<string>());
        Assert.Equal("list_endpoints", tool["function"]!["name"]!.GetValue<string>());
    }

    [Fact]
    public void FromOpenAiResponse_MapsToolCallsAndUsage()
    {
        var body = JsonNode.Parse("""
        {
          "id": "chatcmpl-abc",
          "model": "gpt-5-codex",
          "choices": [{
            "finish_reason": "tool_calls",
            "message": {
              "role": "assistant",
              "content": "Checking communities.",
              "tool_calls": [{
                "id": "call_9",
                "type": "function",
                "function": { "name": "get_communities", "arguments": "{}" }
              }]
            }
          }],
          "usage": { "prompt_tokens": 120, "completion_tokens": 45 }
        }
        """)!;

        var response = OpenAiHttpClient.FromOpenAiResponse(body);

        Assert.Equal("tool_use", response.StopReason);
        Assert.Equal(2, response.Content.Count);
        Assert.Equal("text", response.Content[0].Type);
        Assert.Equal("Checking communities.", response.Content[0].Text);
        var toolUse = response.Content[1];
        Assert.Equal("tool_use", toolUse.Type);
        Assert.Equal("call_9", toolUse.Id);
        Assert.Equal("get_communities", toolUse.Name);
        Assert.NotNull(toolUse.Input);
        Assert.Equal(120, response.Usage!.InputTokens);
        Assert.Equal(45, response.Usage.OutputTokens);
    }

    [Fact]
    public void FromOpenAiResponse_PlainStop_MapsToEndTurn()
    {
        var body = JsonNode.Parse("""
        {
          "choices": [{ "finish_reason": "stop", "message": { "role": "assistant", "content": "Done." } }],
          "usage": { "prompt_tokens": 10, "completion_tokens": 2 }
        }
        """)!;

        var response = OpenAiHttpClient.FromOpenAiResponse(body);

        Assert.Equal("end_turn", response.StopReason);
        var block = Assert.Single(response.Content);
        Assert.Equal("Done.", block.Text);
    }
}
