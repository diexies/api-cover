using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace APICover.Agent.Anthropic;

/// <summary>
/// Request body for POST /v1/messages. Anthropic API version pinned in <see cref="AgentOptions.AnthropicVersion"/>.
/// </summary>
public sealed class MessageRequest
{
    [JsonPropertyName("model")]
    public required string Model { get; init; }

    [JsonPropertyName("max_tokens")]
    public required int MaxTokens { get; init; }

    [JsonPropertyName("system")]
    public string? System { get; init; }

    [JsonPropertyName("messages")]
    public required IReadOnlyList<Message> Messages { get; init; }

    [JsonPropertyName("tools")]
    public IReadOnlyList<ToolDefinition>? Tools { get; init; }

    [JsonPropertyName("temperature")]
    public double? Temperature { get; init; }

    [JsonPropertyName("stream")]
    public bool? Stream { get; init; }
}

public sealed class Message
{
    [JsonPropertyName("role")]
    public required string Role { get; init; }

    [JsonPropertyName("content")]
    public required IReadOnlyList<ContentBlock> Content { get; init; }
}

/// <summary>
/// One content block. Anthropic returns blocks of type "text" or "tool_use"; we send
/// "text", "tool_use" (when echoing back assistant turn), or "tool_result" (when relaying
/// our dispatched tool output).
/// </summary>
public sealed class ContentBlock
{
    [JsonPropertyName("type")]
    public required string Type { get; init; }

    [JsonPropertyName("text")]
    public string? Text { get; init; }

    [JsonPropertyName("id")]
    public string? Id { get; init; }

    [JsonPropertyName("name")]
    public string? Name { get; init; }

    [JsonPropertyName("input")]
    public JsonNode? Input { get; init; }

    [JsonPropertyName("tool_use_id")]
    public string? ToolUseId { get; init; }

    [JsonPropertyName("content")]
    public JsonNode? ToolResultContent { get; init; }

    [JsonPropertyName("is_error")]
    public bool? IsError { get; init; }

    public static ContentBlock TextBlock(string text) => new() { Type = "text", Text = text };

    public static ContentBlock ToolResultBlock(string toolUseId, JsonNode? content, bool isError = false)
        => new() { Type = "tool_result", ToolUseId = toolUseId, ToolResultContent = content, IsError = isError ? true : null };
}

public sealed class ToolDefinition
{
    [JsonPropertyName("name")]
    public required string Name { get; init; }

    [JsonPropertyName("description")]
    public required string Description { get; init; }

    [JsonPropertyName("input_schema")]
    public required JsonNode InputSchema { get; init; }
}

public sealed class MessageResponse
{
    [JsonPropertyName("id")]
    public string? Id { get; init; }

    [JsonPropertyName("role")]
    public string? Role { get; init; }

    [JsonPropertyName("model")]
    public string? Model { get; init; }

    [JsonPropertyName("stop_reason")]
    public string? StopReason { get; init; }

    [JsonPropertyName("content")]
    public IReadOnlyList<ContentBlock> Content { get; init; } = Array.Empty<ContentBlock>();

    [JsonPropertyName("usage")]
    public Usage? Usage { get; init; }
}

public sealed class Usage
{
    [JsonPropertyName("input_tokens")]
    public int InputTokens { get; init; }

    [JsonPropertyName("output_tokens")]
    public int OutputTokens { get; init; }
}

/// <summary>Anthropic error envelope.</summary>
public sealed class AnthropicError
{
    [JsonPropertyName("type")]
    public string? Type { get; init; }

    [JsonPropertyName("message")]
    public string? Message { get; init; }
}

public sealed class AnthropicErrorResponse
{
    [JsonPropertyName("type")]
    public string? Type { get; init; }

    [JsonPropertyName("error")]
    public AnthropicError? Error { get; init; }
}
