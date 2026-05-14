using System.ComponentModel;
using ModelContextProtocol.Server;
using APICover.Abstractions.Discovery;
using APICover.Abstractions.Services;
using APICover.Mcp.Aggregations;

namespace APICover.Mcp.Tools;

[McpServerToolType]
public static class CoverageTools
{
    [McpServerTool(Name = "coverage.summary")]
    [Description("WHEN: user asks overall coverage or wants a single percentage for reporting.\n\nWorkspace coverage snapshot: total endpoints, covered (referenced by at least one scenario node), uncovered count, percentage.")]
    public static async Task<object> Summary(
        IEndpointDiscoveryService discovery,
        IScenarioStore scenarios,
        CancellationToken ct)
    {
        var ep = discovery.GetEndpoints();
        var sc = await scenarios.ListAsync(ct);
        var report = CoverageCalculator.Compute(ep, sc);
        return new
        {
            totalEndpoints = report.TotalEndpoints,
            coveredEndpoints = report.CoveredEndpoints,
            uncoveredEndpoints = report.TotalEndpoints - report.CoveredEndpoints,
            pct = report.Pct,
            scenarios = sc.Count,
        };
    }

    [McpServerTool(Name = "coverage.uncovered_endpoints")]
    [Description("WHEN: user asks 'what should I test next' / 'what is uncovered' — drives gap-filling scenario authoring.\n\nList endpoints that no scenario currently references.")]
    public static async Task<object> Uncovered(
        IEndpointDiscoveryService discovery,
        IScenarioStore scenarios,
        CancellationToken ct)
    {
        var ep = discovery.GetEndpoints();
        var sc = await scenarios.ListAsync(ct);
        var rows = CoverageCalculator.Uncovered(ep, sc).Select(e => new
        {
            id = e.Id,
            method = e.Method,
            path = e.Path,
            area = e.Area,
            purpose = e.Purpose,
            isDeprecated = e.IsDeprecated,
        }).ToArray();
        return new { count = rows.Length, endpoints = rows };
    }
}
