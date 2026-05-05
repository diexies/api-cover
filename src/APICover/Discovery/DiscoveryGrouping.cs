using APICover.Abstractions.Discovery;

namespace APICover.Discovery;

/// <summary>
/// Server-side grouping helper for the discovery payload. Buckets endpoints by
/// <see cref="EndpointDescriptor.Area"/> so the inspector UI can render a folder tree
/// without re-implementing the precedence rules.
/// </summary>
internal static class DiscoveryGrouping
{
    private const string UncategorizedBucket = "uncategorized";

    public static GroupedDiscovery Group(IReadOnlyList<EndpointDescriptor> endpoints)
    {
        var byArea = new Dictionary<string, List<EndpointDescriptor>>(StringComparer.OrdinalIgnoreCase);
        var purposeByArea = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);

        foreach (var ep in endpoints)
        {
            var area = string.IsNullOrWhiteSpace(ep.Area) ? UncategorizedBucket : ep.Area;
            if (!byArea.TryGetValue(area, out var list))
            {
                list = new List<EndpointDescriptor>();
                byArea[area] = list;
                purposeByArea[area] = ep.Purpose;
            }
            list.Add(ep);
        }

        var areas = byArea
            .OrderBy(kv => kv.Key == UncategorizedBucket ? 1 : 0)
            .ThenBy(kv => kv.Key, StringComparer.OrdinalIgnoreCase)
            .Select(kv => new DiscoveryArea
            {
                Name = kv.Key,
                Purpose = purposeByArea[kv.Key],
                Endpoints = kv.Value
            })
            .ToList();

        return new GroupedDiscovery { Areas = areas };
    }
}

/// <summary>Top-level shape returned by <c>GET /inspector/api/discovery/grouped</c>.</summary>
public sealed class GroupedDiscovery
{
    public IReadOnlyList<DiscoveryArea> Areas { get; init; } = Array.Empty<DiscoveryArea>();
}

public sealed class DiscoveryArea
{
    public required string Name { get; init; }
    public string? Purpose { get; init; }
    public IReadOnlyList<EndpointDescriptor> Endpoints { get; init; } = Array.Empty<EndpointDescriptor>();
}
