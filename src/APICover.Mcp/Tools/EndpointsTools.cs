using System.ComponentModel;
using ModelContextProtocol.Server;
using APICover.Abstractions.Discovery;

namespace APICover.Mcp.Tools;

[McpServerToolType]
public static class EndpointsTools
{
    [McpServerTool(Name = "endpoints.list")]
    [Description("WHEN: learning the API surface before authoring scenarios; first step of scenario inference.\n\nList discovered HTTP endpoints. Optionally filter by area (prefix match) or HTTP method (e.g. GET, POST).")]
    public static object List(
        IEndpointDiscoveryService discovery,
        [Description("Area prefix filter, e.g. \"Billing\".")] string? area = null,
        [Description("HTTP method filter, e.g. \"GET\".")] string? methodFilter = null)
    {
        IEnumerable<EndpointDescriptor> filtered = discovery.GetEndpoints();
        if (!string.IsNullOrEmpty(area))
        {
            filtered = filtered.Where(e =>
                e.Area is not null && e.Area.StartsWith(area, StringComparison.OrdinalIgnoreCase));
        }
        if (!string.IsNullOrEmpty(methodFilter))
        {
            filtered = filtered.Where(e =>
                string.Equals(e.Method, methodFilter, StringComparison.OrdinalIgnoreCase));
        }
        var array = filtered.Select(e => new
        {
            id = e.Id,
            method = e.Method,
            path = e.Path,
            area = e.Area,
            purpose = e.Purpose,
            displayName = e.DisplayName,
            isDeprecated = e.IsDeprecated,
            hasRequestBody = e.RequestBody is not null,
            responseStatusCodes = e.Responses.Select(r => r.StatusCode).ToArray(),
        }).ToArray();
        return new { count = array.Length, endpoints = array };
    }

    [McpServerTool(Name = "endpoints.details")]
    [Description("WHEN: about to add an endpoint to a scenario and need its parameter/body schema. Do NOT call for every endpoint — pick promising chains first.\n\nFetch the full descriptor for an endpoint id (e.g. \"GET /invoices/{id}\"). Includes parameters, request/response shapes, samples, and auth requirements.")]
    public static object Details(
        IEndpointDiscoveryService discovery,
        [Description("Endpoint id in the form \"METHOD /path\".")] string id)
    {
        if (string.IsNullOrWhiteSpace(id))
        {
            throw new ArgumentException("Required field 'id' is missing.", nameof(id));
        }
        var endpoint = discovery.GetEndpoints().FirstOrDefault(e => e.Id == id);
        return endpoint is null
            ? new { error = $"No endpoint found with id '{id}'." }
            : (object)endpoint;
    }
}
