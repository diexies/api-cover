using System.Collections.Concurrent;
using System.ComponentModel.DataAnnotations;
using Microsoft.AspNetCore.Mvc;
using APICover.Abstractions.Discovery;

namespace Utopia.Sample.WebApi.Controllers;

/// <summary>
/// Demo controller wired up alongside the minimal-API endpoints to prove discovery handles
/// both styles. Decorated with <see cref="ExploreAreaAttribute"/> so the controller-level
/// area applies to every action; <see cref="ExploreIgnoreAttribute"/> proves per-action exclusion.
///
/// Invoices are persisted in a process-local dictionary so test scenarios that POST then GET
/// see the same record. The store resets on every process restart — exactly what we want for
/// reproducible playground runs.
/// </summary>
[ApiController]
[Route("billing")]
[ExploreArea("billing", Purpose = "internal", Description = "Internal billing operations")]
public sealed class BillingController : ControllerBase
{
    private static readonly ConcurrentDictionary<int, Invoice> _store = new(new[]
    {
        // Seed data so GET works out of the box without a preceding POST. Tests that
        // create new invoices keep incrementing past these ids via `_nextId`.
        new KeyValuePair<int, Invoice>(1, new Invoice(1, 42.50m, "USD")),
        new KeyValuePair<int, Invoice>(2, new Invoice(2, 199.00m, "EUR")),
        new KeyValuePair<int, Invoice>(3, new Invoice(3, 9.99m, "TRY")),
    });
    private static int _nextId = 3;

    [HttpGet("invoices/{id:int}")]
    [ExploreEndpoint(Purpose = "user-action", Description = "Fetch a single invoice")]
    [ProducesResponseType(typeof(Invoice), 200)]
    [ProducesResponseType(404)]
    public ActionResult<Invoice> GetInvoice([FromRoute] int id)
        => _store.TryGetValue(id, out var inv) ? Ok(inv) : NotFound();

    [HttpPost("invoices")]
    [ExploreSample("simple", "{\"amount\":42.5,\"currency\":\"USD\"}")]
    [ProducesResponseType(typeof(Invoice), 201)]
    public ActionResult<Invoice> CreateInvoice([FromBody, Required] CreateInvoiceRequest request)
    {
        var id = Interlocked.Increment(ref _nextId);
        var inv = new Invoice(id, request.Amount, request.Currency);
        _store[id] = inv;
        return Created($"/billing/invoices/{id}", inv);
    }

    [HttpDelete("invoices/{id:int}")]
    [ExploreIgnore]
    public IActionResult DeleteInvoice(int id)
    {
        _store.TryRemove(id, out _);
        return NoContent();
    }
}

public sealed record Invoice(int Id, decimal Amount, string Currency);

public sealed record CreateInvoiceRequest(
    [Range(0.01, 1_000_000)] decimal Amount,
    [StringLength(3, MinimumLength = 3)] string Currency);
