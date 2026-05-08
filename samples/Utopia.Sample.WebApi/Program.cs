using Microsoft.EntityFrameworkCore;
using APICover.Agent.Hosting;
using APICover.Discovery;
using APICover.Hosting;
using APICover.UI.Web;
using Utopia.Sample.WebApi.Services;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();
builder.Services.AddEndpointsApiExplorer();

// Demo billing chain — gives the call-graph walker a real, non-trivial target:
//   POST /invoices → InvoiceService → PaymentGateway (HttpClient → external)
//                                  → InvoiceRepository (EF SaveChangesAsync → database)
builder.Services.AddDbContext<AppDbContext>(o => o.UseInMemoryDatabase("invoices"));
builder.Services.AddScoped<IInvoiceService, InvoiceService>();
builder.Services.AddScoped<IInvoiceRepository, InvoiceRepository>();
builder.Services.AddHttpClient<IPaymentGateway, PaymentGateway>();

builder.Services.AddAPICover(opts =>
{
    // Sample-specific: pin the loopback URL so engine HTTP calls work even before the
    // first inbound request triggers IServerAddressesFeature lookup.
    opts.HostBaseAddress = new Uri("http://localhost:5050");
    // Showcase the call-graph inspection feature — eager warmup is the default.
    opts.EnableCallGraphInspection = true;
});
builder.Services.AddAPICoverWebUI();
builder.Services.AddAPICoverAgent();

var app = builder.Build();

// In-memory user store for the demo.
var users = new Dictionary<int, User>();
var nextId = 0;

app.MapGet("/", () => "Utopia.Sample.WebApi")
    .ExploreIgnore();

// Group all /users endpoints under the "user" area.
var userGroup = app.MapGroup("/users").ExploreArea("user");

userGroup.MapPost("", (User user) =>
    {
        var id = Interlocked.Increment(ref nextId);
        var stored = user with { Id = id };
        users[id] = stored;
        return Results.Created($"/users/{id}", stored);
    })
    .ExploreEndpoint(purpose: "user-action", displayName: "Create user")
    .ExploreSample("ada", "{\"name\":\"Ada\"}");

userGroup.MapGet("/{id:int}", (int id) =>
        users.TryGetValue(id, out var u) ? Results.Ok(u) : Results.NotFound())
    .ExploreEndpoint(purpose: "user-read", displayName: "Get user by id");

userGroup.MapGet("", () => Results.Ok(users.Values))
    .ExploreEndpoint(purpose: "user-read", displayName: "List users");

// Demo SSE endpoint for streaming-node testing.
app.MapGet("/jobs/{id}/events", async (string id, HttpContext ctx, CancellationToken ct) =>
{
    ctx.Response.Headers.ContentType = "text/event-stream";
    ctx.Response.Headers.CacheControl = "no-cache";
    for (var i = 1; i <= 5 && !ct.IsCancellationRequested; i++)
    {
        var status = i < 5 ? "running" : "completed";
        await ctx.Response.WriteAsync($"event: progress\ndata: {{\"step\":{i},\"status\":\"{status}\",\"jobId\":\"{id}\"}}\n\n", ct);
        await ctx.Response.Body.FlushAsync(ct);
        await Task.Delay(20, ct);
    }
})
    .ExploreEndpoint(area: "jobs", purpose: "stream", displayName: "Stream job progress");

app.MapInvoicing();

app.MapControllers();

app.UseAPICover();

// Seed a couple of demo scenarios on startup so the UI has something to show on first load.
await SeedDemoScenarios(app.Services);

app.Run();

static async Task SeedDemoScenarios(IServiceProvider services)
{
    var store = services.GetRequiredService<APICover.Abstractions.Services.IScenarioStore>();
    var existing = await store.ListAsync();
    if (existing.Count > 0) return;

    await store.SaveAsync(new APICover.Abstractions.Models.Scenario
    {
        Id = "create-and-fetch-user",
        Name = "Create then fetch user",
        Description = "POST a new user, then GET it back by id.",
        Nodes =
        {
            new APICover.Abstractions.Models.ApiNode
            {
                Id = "create", Method = "POST", Path = "/users",
                Body = System.Text.Json.Nodes.JsonNode.Parse("""{"name":"Ada"}""")
            },
            new APICover.Abstractions.Models.ApiNode
            {
                Id = "fetch", Method = "GET", Path = "/users/{id}",
                PathParameters =
                {
                    ["id"] = System.Text.Json.Nodes.JsonNode.Parse("""{"var":"nodes.create.response.body.id"}""")
                }
            }
        },
        Edges = { new APICover.Abstractions.Models.Edge { From = "create", To = "fetch" } }
    });

    await store.SaveAsync(new APICover.Abstractions.Models.Scenario
    {
        Id = "watch-job",
        Name = "Watch streaming job",
        Description = "Subscribe to /jobs/{id}/events SSE and stop on completed.",
        Nodes =
        {
            new APICover.Abstractions.Models.ApiNode
            {
                Id = "watch", Method = "GET", Path = "/jobs/{id}/events",
                PathParameters = { ["id"] = System.Text.Json.Nodes.JsonNode.Parse("\"abc-123\"") },
                Streaming = new APICover.Abstractions.Models.StreamingNodeOptions
                {
                    Mode = APICover.Abstractions.Models.StreamingMode.Until,
                    Parser = APICover.Abstractions.Models.StreamParser.Sse,
                    Until = System.Text.Json.Nodes.JsonNode.Parse("""{"==":[{"var":"message.data.status"},"completed"]}"""),
                    Timeout = TimeSpan.FromSeconds(10)
                }
            }
        }
    });
}

public sealed record User(string Name)
{
    public int Id { get; init; }
}

public partial class Program;
