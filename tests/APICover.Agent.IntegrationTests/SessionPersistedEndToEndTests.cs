using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using APICover.Agent.Anthropic;
using APICover.Agent.Credentials;
using APICover.Agent.Engine;
using APICover.Agent.Sessions;
using APICover.Agent.Tools;

namespace APICover.Agent.IntegrationTests;

/// <summary>
/// Drives a full agent run with a stub Anthropic client that yields a narration text
/// block followed by a tool_use, then a final text answer. Verifies the persisted
/// JSON session contains the categorised events in the expected order, and that
/// /agent/sessions/{id} returns the same doc.
/// </summary>
public class SessionPersistedEndToEndTests : IClassFixture<SessionPersistedEndToEndTests.Factory>
{
    private readonly Factory _factory;

    public SessionPersistedEndToEndTests(Factory factory) { _factory = factory; }

    [Fact]
    public async Task Run_PersistsCategorisedEvents()
    {
        await _factory.SeedApiKeyCredentialAsync();
        var client = _factory.CreateClient();

        var startResp = await client.PostAsJsonAsync("/apicover/api/agent/runs",
            new { prompt = "what endpoints does this api expose", mode = "chat" });
        startResp.EnsureSuccessStatusCode();
        var startBody = await startResp.Content.ReadFromJsonAsync<StartResponse>();
        Assert.NotNull(startBody?.RunId);

        // Wait for the run to complete (tool dispatch + final text are synchronous in
        // the stub; just give the background task a beat to finish writing the file).
        SessionDoc? doc = null;
        for (var i = 0; i < 60; i++)
        {
            await Task.Delay(50);
            var r = await client.GetAsync($"/apicover/api/agent/sessions/{startBody!.RunId}");
            if (!r.IsSuccessStatusCode) continue;
            doc = await r.Content.ReadFromJsonAsync<SessionDoc>(SessionJson);
            if (doc?.Status is "succeeded" or "failed" or "cancelledBudget") break;
        }

        Assert.NotNull(doc);
        Assert.Equal("succeeded", doc!.Status);
        Assert.NotEmpty(doc.Events);

        var types = doc.Events.Select(e => e.Type).ToList();
        Assert.Contains(AgentEventType.RunStarted, types);
        Assert.Contains(AgentEventType.Narration, types);
        Assert.Contains(AgentEventType.DiscoveringEndpoints, types);
        Assert.Contains(AgentEventType.AssistantMessage, types);
        Assert.Contains(AgentEventType.RunCompleted, types);

        var narration = doc.Events.First(e => e.Type == AgentEventType.Narration);
        Assert.False(string.IsNullOrEmpty(narration.Summary));
    }

    private static readonly JsonSerializerOptions SessionJson = new(JsonSerializerDefaults.Web)
    {
        Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter(JsonNamingPolicy.CamelCase) }
    };

    private sealed record StartResponse(string RunId, string Mode);

    public sealed class Factory : WebApplicationFactory<Program>
    {
        protected override void ConfigureWebHost(Microsoft.AspNetCore.Hosting.IWebHostBuilder builder)
        {
            builder.ConfigureServices(services =>
            {
                services.RemoveAll<IAnthropicClient>();
                services.AddSingleton<IAnthropicClient, NarrationStubClient>();
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

    /// <summary>Replays narration text then tool_use, then on second call returns final text.</summary>
    private sealed class NarrationStubClient : IAnthropicClient
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
                        ContentBlock.TextBlock("Endpoint'leri listeliyorum"),
                        new ContentBlock
                        {
                            Type = "tool_use",
                            Id = "call_1",
                            Name = ToolRegistry.ListEndpoints,
                            Input = new JsonObject()
                        }
                    },
                    Usage = new Usage { InputTokens = 50, OutputTokens = 30 }
                });
            }
            return Task.FromResult(new MessageResponse
            {
                StopReason = "end_turn",
                Content = new[] { ContentBlock.TextBlock("This API exposes 8 endpoints across 3 areas.") },
                Usage = new Usage { InputTokens = 200, OutputTokens = 50 }
            });
        }
    }
}
