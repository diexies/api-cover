using APICover.Agent.Memory;

namespace APICover.Agent.Tests;

public class MemoryStoreTests
{
    [Fact]
    public async Task Write_Then_Read_RoundTrips()
    {
        var store = new InMemoryAgentMemoryStore();
        await store.WriteAsync("controllers/payment.md", "# Payment\nbody");
        var read = await store.ReadAsync("controllers/payment.md");
        Assert.Equal("# Payment\nbody", read);
    }

    [Fact]
    public async Task Append_CreatesIfMissing()
    {
        var store = new InMemoryAgentMemoryStore();
        await store.AppendAsync("services/foo.md", "first\n");
        await store.AppendAsync("services/foo.md", "second\n");
        var read = await store.ReadAsync("services/foo.md");
        Assert.Equal("first\nsecond\n", read);
    }

    [Fact]
    public async Task List_FiltersByPrefix()
    {
        var store = new InMemoryAgentMemoryStore();
        await store.WriteAsync("services/a.md", "x");
        await store.WriteAsync("services/b.md", "x");
        await store.WriteAsync("controllers/c.md", "x");

        var services = await store.ListAsync("services/");
        Assert.Equal(2, services.Count);
        Assert.All(services, e => Assert.StartsWith("services/", e.Path));
    }

    [Fact]
    public async Task Any_TogglesOnFirstWrite()
    {
        var store = new InMemoryAgentMemoryStore();
        Assert.False(await store.AnyAsync());
        await store.WriteAsync("project.md", "x");
        Assert.True(await store.AnyAsync());
    }

    [Fact]
    public async Task Delete_RemovesFile()
    {
        var store = new InMemoryAgentMemoryStore();
        await store.WriteAsync("project.md", "x");
        await store.DeleteAsync("project.md");
        Assert.Null(await store.ReadAsync("project.md"));
    }

    [Fact]
    public async Task Filesystem_StoresUnderRoot()
    {
        var root = Path.Combine(Path.GetTempPath(), "apicover-test-" + Guid.NewGuid().ToString("N"));
        try
        {
            var opts = Microsoft.Extensions.Options.Options.Create(new AgentOptions { MemoryRoot = root });
            var env = new FakeHostEnv(Path.GetTempPath());
            var store = new FilesystemAgentMemoryStore(opts, env);

            await store.WriteAsync("services/foo.md", "# Foo");
            var path = Path.Combine(root, "services", "foo.md");
            Assert.True(File.Exists(path));
            Assert.Equal("# Foo", File.ReadAllText(path));
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, true);
        }
    }

    [Fact]
    public async Task Filesystem_DefaultsToContentRootDocsApicoverAgent()
    {
        var contentRoot = Path.Combine(Path.GetTempPath(), "apicover-cr-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(contentRoot);
        try
        {
            var opts = Microsoft.Extensions.Options.Options.Create(new AgentOptions());
            var env = new FakeHostEnv(contentRoot);
            var store = new FilesystemAgentMemoryStore(opts, env);

            await store.WriteAsync("project.md", "# proj");
            var expected = Path.Combine(contentRoot, "docs", "apicover-agent", "project.md");
            Assert.True(File.Exists(expected));
        }
        finally
        {
            if (Directory.Exists(contentRoot)) Directory.Delete(contentRoot, true);
        }
    }

    [Fact]
    public async Task Filesystem_RejectsOversize()
    {
        var root = Path.Combine(Path.GetTempPath(), "apicover-test-" + Guid.NewGuid().ToString("N"));
        try
        {
            var opts = Microsoft.Extensions.Options.Options.Create(new AgentOptions { MemoryRoot = root, MaxMemoryFileBytes = 10 });
            var env = new FakeHostEnv(Path.GetTempPath());
            var store = new FilesystemAgentMemoryStore(opts, env);

            await Assert.ThrowsAsync<InvalidOperationException>(
                () => store.WriteAsync("project.md", new string('x', 100)));
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, true);
        }
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
