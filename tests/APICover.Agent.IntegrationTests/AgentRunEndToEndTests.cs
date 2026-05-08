using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using APICover.Agent.Anthropic;
using APICover.Agent.Credentials;
using APICover.Agent.Tools;

namespace APICover.Agent.IntegrationTests;

/// <summary>
/// End-to-end test that exercises the full agent run path: POST /agent/runs → SSE event
/// stream → assert ordering. Uses a stub <see cref="IAnthropicClient"/> that replays one
/// tool-use turn followed by a text-only stop, so the run completes without contacting
/// the real Anthropic API.
/// </summary>
public class AgentRunEndToEndTests : IClassFixture<AgentTestFactory>
{
    private readonly AgentTestFactory _factory;

    public AgentRunEndToEndTests(AgentTestFactory factory) { _factory = factory; }

    [Fact]
    public async Task FullRun_EmitsExpectedEventSequence()
    {
        await _factory.SeedApiKeyCredentialAsync();
        var client = _factory.CreateClient();

        var startResp = await client.PostAsJsonAsync("/apicover/api/agent/runs",
            new { prompt = "What endpoints does this API expose?" });
        startResp.EnsureSuccessStatusCode();
        var startBody = await startResp.Content.ReadFromJsonAsync<StartRunResponse>();
        Assert.NotNull(startBody?.RunId);

        // Read the SSE stream until RunCompleted (timeout 5s).
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        using var sseClient = _factory.CreateClient();
        sseClient.Timeout = TimeSpan.FromSeconds(10);

        // Give the background run a moment to start emitting before we subscribe;
        // events are buffered in the channel so order is preserved either way.
        await Task.Delay(50, cts.Token);

        var url = $"/apicover/api/agent/runs/{startBody!.RunId}/events";
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        using var resp = await sseClient.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        resp.EnsureSuccessStatusCode();
        using var stream = await resp.Content.ReadAsStreamAsync(cts.Token);
        using var reader = new StreamReader(stream);

        var eventTypes = new List<string>();
        string? currentEvent = null;
        var sawRunCompleted = false;
        while (!cts.IsCancellationRequested && !sawRunCompleted)
        {
            var line = await reader.ReadLineAsync(cts.Token);
            if (line is null) break;
            if (line.StartsWith("event: "))
            {
                currentEvent = line["event: ".Length..];
                eventTypes.Add(currentEvent);
                if (currentEvent == "RunCompleted") sawRunCompleted = true;
            }
        }

        Assert.Contains("RunStarted", eventTypes);
        Assert.Contains("ToolCallStarted", eventTypes);
        Assert.Contains("ToolCallCompleted", eventTypes);
        Assert.Contains("TextDelta", eventTypes);
        Assert.Contains("RunCompleted", eventTypes);

        var startedIdx = eventTypes.IndexOf("RunStarted");
        var toolStartedIdx = eventTypes.IndexOf("ToolCallStarted");
        var toolCompletedIdx = eventTypes.IndexOf("ToolCallCompleted");
        var completedIdx = eventTypes.IndexOf("RunCompleted");
        Assert.True(startedIdx < toolStartedIdx);
        Assert.True(toolStartedIdx < toolCompletedIdx);
        Assert.True(toolCompletedIdx < completedIdx);
    }

    private sealed record StartRunResponse(string RunId);
}

public sealed class AgentTestFactory : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(Microsoft.AspNetCore.Hosting.IWebHostBuilder builder)
    {
        builder.ConfigureServices(services =>
        {
            services.RemoveAll<IAnthropicClient>();
            services.AddSingleton<IAnthropicClient, StubAnthropicClient>();
        });
    }

    public async Task SeedApiKeyCredentialAsync()
    {
        using var scope = Services.CreateScope();
        var store = scope.ServiceProvider.GetRequiredService<IAgentCredentialStore>();
        var encryption = scope.ServiceProvider.GetRequiredService<CredentialEncryption>();
        await store.SaveAsync(new StoredCredential(
            Mode: AgentCredentialMode.ApiKey,
            EncryptedApiKey: encryption.Protect("sk-ant-stub-test"),
            LastFourChars: "test",
            DailyDollarCap: 10m,
            UpdatedAt: DateTimeOffset.UtcNow));
    }
}

internal static class ServiceCollectionExtensions
{
    public static void RemoveAll<T>(this IServiceCollection services)
    {
        var descriptors = services.Where(d => d.ServiceType == typeof(T)).ToList();
        foreach (var d in descriptors) services.Remove(d);
    }
}

/// <summary>
/// Replays one tool_use → tool_result → text-only stop. Stateful per-instance: the
/// first SendAsync returns a tool_use; the second returns text + end_turn.
/// </summary>
internal sealed class StubAnthropicClient : IAnthropicClient
{
    private int _calls;

    public Task<MessageResponse> SendAsync(MessageRequest request, CancellationToken cancellationToken)
    {
        _calls++;
        if (_calls == 1)
        {
            return Task.FromResult(new MessageResponse
            {
                StopReason = "tool_use",
                Content = new[]
                {
                    new ContentBlock
                    {
                        Type = "tool_use",
                        Id = "tool_call_1",
                        Name = ToolRegistry.ListEndpoints,
                        Input = new JsonObject()
                    }
                },
                Usage = new Usage { InputTokens = 50, OutputTokens = 20 }
            });
        }

        return Task.FromResult(new MessageResponse
        {
            StopReason = "end_turn",
            Content = new[]
            {
                ContentBlock.TextBlock("This API exposes user and invoicing endpoints.")
            },
            Usage = new Usage { InputTokens = 200, OutputTokens = 30 }
        });
    }
}
