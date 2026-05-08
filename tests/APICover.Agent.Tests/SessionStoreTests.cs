using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using APICover.Agent.Engine;
using APICover.Agent.Sessions;

namespace APICover.Agent.Tests;

public class SessionStoreTests
{
    [Fact]
    public async Task Save_Then_Get_RoundTrips()
    {
        await using var fixture = new SessionsFixture();
        var doc = new SessionDoc
        {
            Id = "abc-123",
            Prompt = "what does this api do",
            Mode = "chat",
            StartedAt = DateTimeOffset.UtcNow,
            Status = "running",
            Model = "claude-opus-4-7"
        };
        doc.Events.Add(new AgentEvent { Type = AgentEventType.RunStarted, RunId = doc.Id });
        doc.Events.Add(new AgentEvent { Type = AgentEventType.Narration, RunId = doc.Id, Summary = "thinking" });

        await fixture.Store.SaveAsync(doc);
        var roundTripped = await fixture.Store.GetAsync(doc.Id);

        Assert.NotNull(roundTripped);
        Assert.Equal(doc.Id, roundTripped!.Id);
        Assert.Equal(2, roundTripped.Events.Count);
        Assert.Equal(AgentEventType.Narration, roundTripped.Events[1].Type);
        Assert.Equal("thinking", roundTripped.Events[1].Summary);
    }

    [Fact]
    public async Task List_OrdersByMostRecent()
    {
        await using var fixture = new SessionsFixture();
        var olderId = "older-id";
        var newerId = "newer-id";

        await fixture.Store.SaveAsync(new SessionDoc
        {
            Id = olderId, Prompt = "old", Mode = "chat",
            StartedAt = DateTimeOffset.UtcNow.AddMinutes(-10),
            Status = "succeeded", Model = "x"
        });
        await Task.Delay(50);
        await fixture.Store.SaveAsync(new SessionDoc
        {
            Id = newerId, Prompt = "new", Mode = "chat",
            StartedAt = DateTimeOffset.UtcNow,
            Status = "succeeded", Model = "x"
        });

        var list = await fixture.Store.ListAsync();

        Assert.Equal(newerId, list[0].Id);
        Assert.Equal(olderId, list[1].Id);
    }

    [Fact]
    public async Task Save_RejectsInvalidId()
    {
        await using var fixture = new SessionsFixture();
        var bad = new SessionDoc
        {
            Id = "../../../etc/passwd",
            Prompt = "hack",
            Mode = "chat",
            StartedAt = DateTimeOffset.UtcNow,
            Status = "running",
            Model = "x"
        };
        await Assert.ThrowsAsync<ArgumentException>(() => fixture.Store.SaveAsync(bad));
    }

    [Fact]
    public async Task Get_ReturnsNullForUnknown()
    {
        await using var fixture = new SessionsFixture();
        var doc = await fixture.Store.GetAsync("nonexistent");
        Assert.Null(doc);
    }

    [Fact]
    public async Task Save_PartitionsByDate()
    {
        await using var fixture = new SessionsFixture();
        var doc = new SessionDoc
        {
            Id = "date-test",
            Prompt = "x",
            Mode = "chat",
            StartedAt = new DateTimeOffset(2026, 5, 7, 12, 0, 0, TimeSpan.Zero),
            Status = "succeeded",
            Model = "x"
        };
        await fixture.Store.SaveAsync(doc);
        var expected = Path.Combine(fixture.Store.RootPath, "2026-05-07", "date-test.json");
        Assert.True(File.Exists(expected));
    }

    private sealed class SessionsFixture : IAsyncDisposable
    {
        public string Root { get; } = Path.Combine(Path.GetTempPath(), "apicover-sess-test-" + Guid.NewGuid().ToString("N"));
        public IAgentSessionStore Store { get; }

        public SessionsFixture()
        {
            var opts = Options.Create(new AgentOptions { SessionsRoot = Root });
            var env = new FakeHostEnv(Path.GetTempPath());
            Store = new FilesystemAgentSessionStoreAccessor(opts, env);
        }

        public ValueTask DisposeAsync()
        {
            if (Directory.Exists(Root)) Directory.Delete(Root, true);
            return ValueTask.CompletedTask;
        }
    }

    /// <summary>Inherits from the internal store to make it test-accessible via InternalsVisibleTo.</summary>
    private sealed class FilesystemAgentSessionStoreAccessor : IAgentSessionStore
    {
        private readonly IAgentSessionStore _inner;
        public FilesystemAgentSessionStoreAccessor(IOptions<AgentOptions> options, IHostEnvironment env)
        {
            // Use reflection-free access via the internal type by making it public is a
            // bigger change; the integration test factory exercises the real impl via DI.
            // Here we just resolve via the same constructor.
            var type = typeof(IAgentSessionStore).Assembly.GetType("APICover.Agent.Sessions.FilesystemAgentSessionStore")!;
            _inner = (IAgentSessionStore)Activator.CreateInstance(type, options, env)!;
        }
        public string RootPath => _inner.RootPath;
        public Task SaveAsync(SessionDoc s, CancellationToken c = default) => _inner.SaveAsync(s, c);
        public Task<SessionDoc?> GetAsync(string id, CancellationToken c = default) => _inner.GetAsync(id, c);
        public Task<IReadOnlyList<SessionSummary>> ListAsync(int take = 50, CancellationToken c = default) => _inner.ListAsync(take, c);
        public Task DeleteAsync(string id, CancellationToken c = default) => _inner.DeleteAsync(id, c);
    }

    private sealed class FakeHostEnv : Microsoft.Extensions.Hosting.IHostEnvironment
    {
        public FakeHostEnv(string contentRoot) { ContentRootPath = contentRoot; }
        public string EnvironmentName { get; set; } = "Test";
        public string ApplicationName { get; set; } = "APICover.Agent.Tests";
        public string ContentRootPath { get; set; }
        public Microsoft.Extensions.FileProviders.IFileProvider ContentRootFileProvider { get; set; } = null!;
    }
}
