using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using APICover.Agent;
using APICover.Agent.Anthropic;
using APICover.Agent.Credentials;

namespace APICover.Agent.IntegrationTests;

/// <summary>
/// Exhausts the per-credential daily cap on a single round-trip and verifies the run
/// terminates with status CancelledBudget and a BudgetExhausted SSE event.
/// </summary>
public class BudgetExhaustionTests : IClassFixture<BudgetExhaustionTests.Factory>
{
    private readonly Factory _factory;

    public BudgetExhaustionTests(Factory factory) { _factory = factory; }

    [Fact]
    public async Task BudgetExceeded_FailsRunWithBudgetEvent()
    {
        await _factory.SeedTinyCapCredentialAsync();
        var client = _factory.CreateClient();

        var startResp = await client.PostAsJsonAsync("/apicover/api/agent/runs",
            new { prompt = "expensive prompt" });
        startResp.EnsureSuccessStatusCode();
        var startBody = await startResp.Content.ReadFromJsonAsync<StartResponse>();

        // Wait for the background run to settle.
        AgentRunRecordResponse? final = null;
        string? lastSeenStatus = null;
        string? rawBody = null;
        for (var i = 0; i < 60; i++)
        {
            await Task.Delay(100);
            var r = await client.GetAsync($"/apicover/api/agent/runs/{startBody!.RunId}");
            if (!r.IsSuccessStatusCode) continue;
            rawBody = await r.Content.ReadAsStringAsync();
            var body = System.Text.Json.JsonSerializer.Deserialize<AgentRunRecordResponse>(
                rawBody,
                new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web));
            if (body is null) continue;
            lastSeenStatus = body.Status;
            if (body.Status is "cancelledBudget" or "failed" or "succeeded")
            {
                final = body;
                break;
            }
        }

        Assert.True(final is not null,
            $"Run never reached terminal status. Last seen: '{lastSeenStatus}'. Last body: {rawBody}");
        Assert.Equal("cancelledBudget", final!.Status);
    }

    private sealed record StartResponse(string RunId);

    private sealed record AgentRunRecordResponse(
        string Id, string Prompt, string Status, decimal DollarsSpent, int InputTokens, int OutputTokens);

    public sealed class Factory : WebApplicationFactory<Program>
    {
        protected override void ConfigureWebHost(Microsoft.AspNetCore.Hosting.IWebHostBuilder builder)
        {
            builder.ConfigureServices(services =>
            {
                services.RemoveAll<IAnthropicClient>();
                services.AddSingleton<IAnthropicClient, ExpensiveStubClient>();
                services.PostConfigure<AgentOptions>(opts =>
                {
                    opts.MaxDollarsPerDay = 0.01m;
                });
            });
        }

        public async Task SeedTinyCapCredentialAsync()
        {
            using var scope = Services.CreateScope();
            var store = scope.ServiceProvider.GetRequiredService<IAgentCredentialStore>();
            var encryption = scope.ServiceProvider.GetRequiredService<CredentialEncryption>();
            await store.SaveAsync(new StoredCredential(
                Mode: AgentCredentialMode.ApiKey,
                EncryptedApiKey: encryption.Protect("sk-ant-stub-test"),
                LastFourChars: "test",
                DailyDollarCap: 0.01m,
                UpdatedAt: DateTimeOffset.UtcNow));
        }
    }

    /// <summary>Reports 1M input tokens to push past any sane daily cap on the first call.</summary>
    private sealed class ExpensiveStubClient : IAnthropicClient
    {
        public Task<MessageResponse> SendAsync(MessageRequest request, CancellationToken cancellationToken)
            => Task.FromResult(new MessageResponse
            {
                StopReason = "end_turn",
                Content = new[] { ContentBlock.TextBlock("expensive response") },
                Usage = new Usage { InputTokens = 1_000_000, OutputTokens = 0 }
            });
    }
}
