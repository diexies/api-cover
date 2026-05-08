namespace APICover.Agent.Anthropic;

/// <summary>
/// Abstraction over the Anthropic Messages API. Two impls in M1: real HTTP (<see cref="AnthropicHttpClient"/>)
/// and a CLI bridge for Max subscriptions (<see cref="Credentials.ClaudeCliBridge"/>). Tests
/// supply a stub that replays canned tool-use turns.
/// </summary>
public interface IAnthropicClient
{
    /// <summary>One round-trip; non-streaming for M1 (we stream the agent's outer loop as
    /// SSE to the UI, not the per-token stream from Anthropic).</summary>
    Task<MessageResponse> SendAsync(MessageRequest request, CancellationToken cancellationToken);
}
