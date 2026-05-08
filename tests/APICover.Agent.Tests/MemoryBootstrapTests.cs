using APICover.Agent.Memory;

namespace APICover.Agent.Tests;

public class MemoryBootstrapTests
{
    [Fact]
    public async Task Ensure_CopiesIntroduceMd_OnFirstBoot()
    {
        var store = new InMemoryAgentMemoryStore();
        var bootstrap = new MemoryBootstrap(store);

        await bootstrap.EnsureAsync();

        var content = await store.ReadAsync("introduce.md");
        Assert.NotNull(content);
        Assert.Contains("APICover", content);
        Assert.Contains("Memory protocol", content);
    }

    [Fact]
    public async Task Ensure_DoesNotOverwrite_HumanEdit()
    {
        var store = new InMemoryAgentMemoryStore();
        await store.WriteAsync("introduce.md", "human edited content");
        var bootstrap = new MemoryBootstrap(store);

        await bootstrap.EnsureAsync();

        Assert.Equal("human edited content", await store.ReadAsync("introduce.md"));
    }

    [Fact]
    public async Task GetIndexSnapshot_GeneratesFromTree_WhenNoIndexMd()
    {
        var store = new InMemoryAgentMemoryStore();
        await store.WriteAsync("controllers/payment.md", "x");
        await store.WriteAsync("services/payment-service.md", "x");
        var bootstrap = new MemoryBootstrap(store);
        await bootstrap.EnsureAsync();

        var snapshot = await bootstrap.GetIndexSnapshotAsync();

        Assert.Contains("controllers/payment.md", snapshot);
        Assert.Contains("services/payment-service.md", snapshot);
        // Bootstrap files must not be listed.
        Assert.DoesNotContain("introduce.md](introduce.md)", snapshot);
    }
}
