using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using APICover.Agent.Credentials;

namespace APICover.Agent.Anthropic;

/// <summary>
/// Direct Anthropic Messages API client. Pinned to API version <c>2023-06-01</c>. Retries
/// 429 and 529 (overloaded) up to 3 times with jittered backoff; everything else surfaces
/// as <see cref="HttpRequestException"/>.
/// </summary>
internal sealed class AnthropicHttpClient : IAnthropicClient
{
    public const string HttpClientName = "apicover.agent.anthropic";

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull
    };

    private readonly IHttpClientFactory _factory;
    private readonly IClaudeCredentialProvider _credentials;
    private readonly IOptions<AgentOptions> _options;

    public AnthropicHttpClient(
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
        if (credential is not ApiKeyCredential apiKey)
        {
            throw new InvalidOperationException(
                "AnthropicHttpClient requires an API-key credential; Max subscription path is handled by ClaudeCliBridge.");
        }

        var client = _factory.CreateClient(HttpClientName);
        var attempt = 0;
        while (true)
        {
            attempt++;
            using var msg = new HttpRequestMessage(HttpMethod.Post, "v1/messages")
            {
                Content = JsonContent.Create(request, options: Json)
            };
            msg.Headers.TryAddWithoutValidation("x-api-key", apiKey.Key);
            msg.Headers.TryAddWithoutValidation("anthropic-version", _options.Value.AnthropicVersion);

            using var response = await client.SendAsync(msg, cancellationToken);

            if (response.IsSuccessStatusCode)
            {
                var body = await response.Content.ReadFromJsonAsync<MessageResponse>(Json, cancellationToken);
                return body ?? throw new InvalidOperationException("Anthropic returned an empty response body.");
            }

            if (ShouldRetry(response.StatusCode) && attempt < 3)
            {
                var delay = TimeSpan.FromMilliseconds(500 * Math.Pow(2, attempt - 1) + Random.Shared.Next(0, 250));
                await Task.Delay(delay, cancellationToken);
                continue;
            }

            var errorPayload = await TryReadErrorAsync(response, cancellationToken);
            throw new HttpRequestException(
                $"Anthropic request failed: {(int)response.StatusCode} {response.ReasonPhrase}. {errorPayload}",
                inner: null,
                statusCode: response.StatusCode);
        }
    }

    private static bool ShouldRetry(HttpStatusCode code)
        => code == HttpStatusCode.TooManyRequests || (int)code == 529;

    private static async Task<string> TryReadErrorAsync(HttpResponseMessage response, CancellationToken ct)
    {
        try
        {
            var error = await response.Content.ReadFromJsonAsync<AnthropicErrorResponse>(Json, ct);
            return error?.Error?.Message ?? string.Empty;
        }
        catch
        {
            return string.Empty;
        }
    }

    public static void Configure(IHttpClientBuilder builder)
    {
        builder.ConfigureHttpClient((sp, client) =>
        {
            var opt = sp.GetRequiredService<IOptions<AgentOptions>>().Value;
            client.BaseAddress = opt.AnthropicBaseAddress;
            client.Timeout = TimeSpan.FromSeconds(opt.RequestTimeoutSeconds);
            client.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("APICover.Agent", "0.1.0"));
        });
    }
}
