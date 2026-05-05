using Microsoft.EntityFrameworkCore;
using APICover.Abstractions.Discovery;
using APICover.Discovery;

namespace Utopia.Sample.WebApi.Services;

// ─── Domain ─────────────────────────────────────────────────────────────────────────

/// <summary>Stored invoice row. Used by both the EF DbContext and the HTTP DTOs.</summary>
public sealed class Invoice
{
    public int Id { get; set; }
    public string Customer { get; set; } = "";
    public decimal Amount { get; set; }
    public string Status { get; set; } = "pending";
}

public sealed record CreateInvoiceRequest(string Customer, decimal Amount);

// ─── EF DbContext (in-memory) ───────────────────────────────────────────────────────

/// <summary>EF in-memory DbContext exposing one Invoices table — enough surface for the
/// call-graph walker to detect <c>SaveChangesAsync</c> as a database boundary.</summary>
public sealed class AppDbContext : DbContext
{
    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }
    public DbSet<Invoice> Invoices => Set<Invoice>();
}

// ─── Service chain (the call-graph poster child) ────────────────────────────────────

[ExploreSummary("Orchestrates the full invoice lifecycle: charge the gateway, persist the row, return the result.")]
public interface IInvoiceService
{
    [ExploreSummary("Charges payment then writes the invoice to the database. Returns the persisted row including the generated id.")]
    Task<Invoice> CreateInvoiceAsync(CreateInvoiceRequest req, CancellationToken ct);
}

[ExploreSummary("Wraps the third-party payments API. Authenticates and forwards the charge.")]
public interface IPaymentGateway
{
    [ExploreSummary("Captures funds for the customer. Returns true on success, false when the gateway declines.")]
    Task<bool> ChargeAsync(string customer, decimal amount, CancellationToken ct);
}

[ExploreSummary("EF-backed persistence for invoices.")]
public interface IInvoiceRepository
{
    [ExploreSummary("Inserts the invoice and saves to the database. Mutates the row to assign Id.")]
    Task<Invoice> AddAsync(Invoice invoice, CancellationToken ct);
}

public sealed class InvoiceService : IInvoiceService
{
    private readonly IPaymentGateway _gateway;
    private readonly IInvoiceRepository _repo;

    public InvoiceService(IPaymentGateway gateway, IInvoiceRepository repo)
    {
        _gateway = gateway;
        _repo = repo;
    }

    public async Task<Invoice> CreateInvoiceAsync(CreateInvoiceRequest req, CancellationToken ct)
    {
        var charged = await _gateway.ChargeAsync(req.Customer, req.Amount, ct);
        var invoice = new Invoice
        {
            Customer = req.Customer,
            Amount = req.Amount,
            Status = charged ? "paid" : "rejected",
        };
        return await _repo.AddAsync(invoice, ct);
    }
}

public sealed class PaymentGateway : IPaymentGateway
{
    private readonly HttpClient _client;

    public PaymentGateway(HttpClient client) { _client = client; }

    public async Task<bool> ChargeAsync(string customer, decimal amount, CancellationToken ct)
    {
        // External HTTP boundary — the walker should mark this as ExternalHttp and surface
        // the URL via best-effort ldstr capture.
        using var resp = await _client.PostAsJsonAsync("https://payments.example.com/charge",
            new { customer, amount }, ct);
        return resp.IsSuccessStatusCode;
    }
}

public sealed class InvoiceRepository : IInvoiceRepository
{
    private readonly AppDbContext _db;

    public InvoiceRepository(AppDbContext db) { _db = db; }

    public async Task<Invoice> AddAsync(Invoice invoice, CancellationToken ct)
    {
        _db.Invoices.Add(invoice);
        // Database boundary — the walker should mark this as Database.
        await _db.SaveChangesAsync(ct);
        return invoice;
    }
}

// ─── Endpoint ───────────────────────────────────────────────────────────────────────

/// <summary>Map the demo billing endpoint. Separated from <c>Program.cs</c> for clarity.</summary>
public static class InvoicingEndpoints
{
    public static void MapInvoicing(this WebApplication app)
    {
        app.MapPost("/invoices", async (CreateInvoiceRequest req, IInvoiceService svc, CancellationToken ct) =>
        {
            var invoice = await svc.CreateInvoiceAsync(req, ct);
            return Results.Created($"/invoices/{invoice.Id}", invoice);
        })
            .ExploreArea("invoicing")
            .ExploreEndpoint(purpose: "user-action", displayName: "Create invoice");

        app.MapGet("/invoices/{id:int}", async (int id, AppDbContext db, CancellationToken ct) =>
                await db.Invoices.FindAsync(new object[] { id }, ct) is { } found
                    ? Results.Ok(found) : Results.NotFound())
            .ExploreArea("invoicing")
            .ExploreEndpoint(purpose: "user-read", displayName: "Get invoice by id");
    }
}
