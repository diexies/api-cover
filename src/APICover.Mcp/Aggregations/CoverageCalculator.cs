using APICover.Abstractions.Discovery;
using APICover.Abstractions.Models;

namespace APICover.Mcp.Aggregations;

/// <summary>
/// Endpoint × scenario coverage. Mirrors the rule the UI's <c>coverage()</c>
/// helper applies in <c>ui/src/home/utils.ts</c>: an endpoint is "covered" when
/// at least one scenario node references the same METHOD + normalised path.
/// </summary>
internal static class CoverageCalculator
{
    public static CoverageReport Compute(
        IReadOnlyList<EndpointDescriptor> endpoints,
        IReadOnlyList<Scenario> scenarios)
    {
        var refs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var s in scenarios)
        {
            foreach (var n in s.Nodes)
            {
                refs.Add(Key(n.Method, NormalisePath(n.Path)));
            }
        }
        var total = endpoints.Count;
        var covered = endpoints.Count(e => refs.Contains(Key(e.Method, NormalisePath(e.Path))));
        var pct = total == 0 ? 0 : (int)Math.Round(100.0 * covered / total);
        return new CoverageReport(total, covered, pct);
    }

    public static IReadOnlyList<EndpointDescriptor> Uncovered(
        IReadOnlyList<EndpointDescriptor> endpoints,
        IReadOnlyList<Scenario> scenarios)
    {
        var refs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var s in scenarios)
        {
            foreach (var n in s.Nodes)
            {
                refs.Add(Key(n.Method, NormalisePath(n.Path)));
            }
        }
        return endpoints
            .Where(e => !refs.Contains(Key(e.Method, NormalisePath(e.Path))))
            .ToArray();
    }

    private static string Key(string method, string path) => $"{method.ToUpperInvariant()} {path}";

    /// <summary>Strip route constraints so "/users/{id:int}" matches "/users/{id}".</summary>
    private static string NormalisePath(string p)
        => System.Text.RegularExpressions.Regex.Replace(p, @"\{([^:}]+):[^}]+\}", "{$1}");
}

internal sealed record CoverageReport(int TotalEndpoints, int CoveredEndpoints, int Pct);
