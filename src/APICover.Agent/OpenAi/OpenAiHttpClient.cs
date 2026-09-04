using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Options;
using APICover.Agent.Anthropic;
using APICover.Agent.Credentials;

namespace APICover.Agent.OpenAi;

/// <summary>
/// OpenAI Chat Completions client behind the agent's Anthropic-shaped internal model.
/// The coordinator keeps speaking content blocks (text / tool_use / tool_result); this
/// client translates both directions at the wire:
///   system            → messages[0] role:system
///   tool_use block    → assistant tool_calls[{ id, function:{ name, arguments } }]
///   tool_result block → role:tool message with tool_call_id
///   response tool_calls → tool_use blocks; finish_reason tool_calls → stop_reason tool_use
/// Retries 429/5xx up to 3 times with jittered backoff, mirroring AnthropicHttpClient.
/// </summary>
internal sealed class OpenAiHttpClient : IAnthropicClient
{
    public const string HttpClientName = "apicover.agent.openai";

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull
    };

    private readonly IHttpClientFactory _factory;
    private readonly IClaudeCredentialProvider _credentials;
    private readonly IOptions<AgentOptions> _options;

    public OpenAiHttpClient(
        IHttpClientFactory factory,
        IClaudeCredentialProvider credentials,
        IOptions<AgentOptions> options)
    {
        _factory = factory;
        _credentials = credentials;
        _options = options;
    }

    public async Task<MessageResponse> SendAsync(MessageRequest request, CancellationToken cancellationToken)
    {
        var credential = await _credentials.GetAsync(cancellationToken);
        if (credential is not ApiKeyCredential { Provider: AgentProvider.OpenAI } apiKey)
        {
            throw new InvalidOperationException("OpenAiHttpClient requires an OpenAI API-key credential.");
        }

        var model = apiKey.Model ?? _options.Value.OpenAiModel;
        var payload = ToOpenAiPayload(request, model);

        var client = _factory.CreateClient(HttpClientName);
        var attempt = 0;
        while (true)
        {
            attempt++;
            using var msg = new HttpRequestMessage(HttpMethod.Post, "v1/chat/completions")
            {
                Content = JsonContent.Create(payload, options: Json)
            };
            msg.Headers.TryAddWithoutValidation("Authorization", $"Bearer {apiKey.Key}");

            using var response = await client.SendAsync(msg, cancellationToken);
            if (response.StatusCode is HttpStatusCode.TooManyRequests or >= HttpStatusCode.InternalServerError && attempt < 3)
            {
                var delayMs = 500 * attempt + Random.Shared.Next(0, 400);
                await Task.Delay(delayMs, cancellationToken);
                continue;
            }
            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                var detail = TryExtractError(body) ?? body;
                throw new HttpRequestException($"OpenAI API {(int)response.StatusCode}: {Truncate(detail, 500)}");
            }
            var node = JsonNode.Parse(body) ?? throw new HttpRequestException("OpenAI API returned an empty body.");
            return FromOpenAiResponse(node);
        }
    }

    /// <summary>Internal request → Chat Completions payload. Static for unit testing.</summary>
    internal static JsonObject ToOpenAiPayload(MessageRequest request, string model)
    {
        var messages = new JsonArray();
        if (!string.IsNullOrEmpty(request.System))
        {
            messages.Add(new JsonObject { ["role"] = "system", ["content"] = request.System });
        }

        foreach (var m in request.Messages)
        {
            if (m.Role == "assistant")
            {
                var text = string.Join("\n", m.Content.Where(b => b.Type == "text" && b.Text is not null).Select(b => b.Text));
                var toolCalls = new JsonArray();
                foreach (var b in m.Content.Where(b => b.Type == "tool_use"))
                {
                    toolCalls.Add(new JsonObject
                    {
                        ["id"] = b.Id,
                        ["type"] = "function",
                        ["function"] = new JsonObject
                        {
                            ["name"] = b.Name,
                            ["arguments"] = b.Input?.ToJsonString(Json) ?? "{}",
                        },
                    });
                }
                var assistant = new JsonObject { ["role"] = "assistant" };
                if (text.Length > 0) assistant["content"] = text;
                if (toolCalls.Count > 0) assistant["tool_calls"] = toolCalls;
                if (text.Length == 0 && toolCalls.Count == 0) assistant["content"] = string.Empty;
                messages.Add(assistant);
                continue;
            }

            // User turns: tool_result blocks become role:tool messages (must directly
            // follow the assistant tool_calls turn); plain text becomes a user message.
            foreach (var b in m.Content)
            {
                switch (b.Type)
                {
                    case "tool_result":
                        messages.Add(new JsonObject
                        {
                            ["role"] = "tool",
                            ["tool_call_id"] = b.ToolUseId,
                            ["content"] = b.ToolResultContent?.ToJsonString(Json) ?? "null",
                        });
                        break;
                    case "text" when !string.IsNullOrEmpty(b.Text):
                        messages.Add(new JsonObject { ["role"] = "user", ["content"] = b.Text });
                        break;
                }
            }
        }

        var payload = new JsonObject
        {
            ["model"] = model,
            ["max_completion_tokens"] = request.MaxTokens,
            ["messages"] = messages,
        };
        if (request.Temperature is { } t) payload["temperature"] = t;
        if (request.Tools is { Count: > 0 } tools)
        {
            var arr = new JsonArray();
            foreach (var tool in tools)
            {
                arr.Add(new JsonObject
                {
                    ["type"] = "function",
                    ["function"] = new JsonObject
                    {
                        ["name"] = tool.Name,
                        ["description"] = tool.Description,
                        ["parameters"] = tool.InputSchema.DeepClone(),
                    },
                });
            }
            payload["tools"] = arr;
        }
        return payload;
    }

    /// <summary>Chat Completions response → internal MessageResponse. Static for unit testing.</summary>
    internal static MessageResponse FromOpenAiResponse(JsonNode node)
    {
        var choice = node["choices"]?[0];
        var message = choice?["message"];
        var blocks = new List<ContentBlock>();

        if (message?["content"]?.GetValue<string>() is { Length: > 0 } text)
        {
            blocks.Add(ContentBlock.TextBlock(text));
        }
        if (message?["tool_calls"] is JsonArray calls)
        {
            foreach (var call in calls)
            {
                var fn = call?["function"];
                JsonNode? input = null;
                var arguments = fn?["arguments"]?.GetValue<string>();
                if (!string.IsNullOrEmpty(arguments))
                {
                    try { input = JsonNode.Parse(arguments); } catch { input = JsonValue.Create(arguments); }
                }
                blocks.Add(new ContentBlock
                {
                    Type = "tool_use",
                    Id = call?["id"]?.GetValue<string>(),
                    Name = fn?["name"]?.GetValue<string>(),
                    Input = input,
                });
            }
        }

        var finish = choice?["finish_reason"]?.GetValue<string>();
        var stopReason = finish switch
        {
            "tool_calls" => "tool_use",
            "stop" => "end_turn",
            "length" => "max_tokens",
            _ => finish,
        };

        return new MessageResponse
        {
            Id = node["id"]?.GetValue<string>(),
            Role = "assistant",
            Model = node["model"]?.GetValue<string>(),
            StopReason = stopReason,
            Content = blocks,
            Usage = new Usage
            {
                InputTokens = node["usage"]?["prompt_tokens"]?.GetValue<int>() ?? 0,
                OutputTokens = node["usage"]?["completion_tokens"]?.GetValue<int>() ?? 0,
            },
        };
    }

    private static string? TryExtractError(string body)
    {
        try { return JsonNode.Parse(body)?["error"]?["message"]?.GetValue<string>(); }
        catch { return null; }
    }

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max] + "…";
}
