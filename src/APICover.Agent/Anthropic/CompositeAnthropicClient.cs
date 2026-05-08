using APICover.Agent.Credentials;

namespace APICover.Agent.Anthropic;

/// <summary>
/// Picks between <see cref="AnthropicHttpClient"/> and <see cref="ClaudeCliBridge"/> per
/// call based on the resolved credential. Lets the rest of the engine depend on a single
/// <see cref="IAnthropicClient"/> abstraction without caring about transport.
/// </summary>
internal sealed class CompositeAnthropicClient : IAnthropicClient
{
    private readonly IClaudeCredentialProvider _credentials;
    private readonly AnthropicHttpClient _http;
    private readonly ClaudeCliBridge _cli;

    public CompositeAnthropicClient(
        IClaudeCredentialProvider credentials,
        AnthropicHttpClient http,
        ClaudeCliBridge cli)
    {
        _credentials = credentials;
        _http = http;
        _cli = cli;
    }

    public async Task<MessageResponse> SendAsync(MessageRequest request, CancellationToken cancellationToken)
    {
        var credential = await _credentials.GetAsync(cancellationToken);
        return credential switch
        {
            ApiKeyCredential => await _http.SendAsync(request, cancellationToken),
            MaxSubscriptionCredential => await _cli.SendAsync(request, cancellationToken),
            _ => throw new InvalidOperationException($"Unhandled credential type: {credential.GetType().Name}")
        };
    }
}
