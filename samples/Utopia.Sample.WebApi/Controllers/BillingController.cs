using System.ComponentModel.DataAnnotations;
using Microsoft.AspNetCore.Mvc;
using APICover.Abstractions.Discovery;

namespace Utopia.Sample.WebApi.Controllers;

/// <summary>
/// Demo controller wired up alongside the minimal-API endpoints to prove discovery handles
/// both styles. Decorated with <see cref="ExploreAreaAttribute"/> so the controller-level
/// area applies to every action; <see cref="ExploreIgnoreAttribute"/> proves per-action exclusion.
/// </summary>
[ApiController]
[Route("billing")]
[ExploreArea("billing", Purpose = "internal", Description = "Internal billing operations")]
public sealed class BillingController : ControllerBase
{
    [HttpGet("invoices/{id:int}")]
    [ExploreEndpoint(Purpose = "user-action", Description = "Fetch a single invoice")]
    [ProducesResponseType(typeof(Invoice), 200)]
    [ProducesResponseType(404)]
    public ActionResult<Invoice> GetInvoice([FromRoute] int id)
        => Ok(new Invoice(id, 0m, "USD"));

    [HttpPost("invoices")]
    [ExploreSample("simple", "{\"amount\":42.5,\"currency\":\"USD\"}")]
    [ProducesResponseType(typeof(Invoice), 201)]
    public ActionResult<Invoice> CreateInvoice([FromBody, Required] CreateInvoiceRequest request)
        => Created($"/billing/invoices/1", new Invoice(1, request.Amount, request.Currency));

    [HttpDelete("invoices/{id:int}")]
    [ExploreIgnore]
    public IActionResult DeleteInvoice(int id) => NoContent();
}

public sealed record Invoice(int Id, decimal Amount, string Currency);

public sealed record CreateInvoiceRequest(
    [property: Range(0.01, 1_000_000)] decimal Amount,
    [property: StringLength(3, MinimumLength = 3)] string Currency);
