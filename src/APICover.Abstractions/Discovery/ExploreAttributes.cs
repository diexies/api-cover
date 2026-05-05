namespace APICover.Abstractions.Discovery;

/// <summary>
/// Marks a controller class or action with a logical Utopia "area" (UI grouping).
/// On a controller class, applies to every action that does not override it.
/// </summary>
[AttributeUsage(AttributeTargets.Class | AttributeTargets.Method, AllowMultiple = false, Inherited = true)]
public sealed class ExploreAreaAttribute : Attribute
{
    public ExploreAreaAttribute(string area)
    {
        if (string.IsNullOrWhiteSpace(area))
        {
            throw new ArgumentException("Area cannot be empty.", nameof(area));
        }
        Area = area;
    }

    public string Area { get; }

    /// <summary>Optional intent label propagated to descendants ("user-action", "internal", …).</summary>
    public string? Purpose { get; init; }

    /// <summary>Optional human description.</summary>
    public string? Description { get; init; }
}

/// <summary>
/// Method-level enrichment for an endpoint. Overrides class-level <see cref="ExploreAreaAttribute"/>.
/// Also usable as endpoint metadata via the fluent <c>ExploreEndpoint(...)</c> minimal-API extension.
/// </summary>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = false, Inherited = false)]
public sealed class ExploreEndpointAttribute : Attribute
{
    public string? Area { get; init; }
    public string? Purpose { get; init; }
    public string? Description { get; init; }
    public string? DisplayName { get; init; }
    public string[] Tags { get; init; } = Array.Empty<string>();
}

/// <summary>Excludes the decorated endpoint (or every action of the class) from discovery.</summary>
[AttributeUsage(AttributeTargets.Class | AttributeTargets.Method, AllowMultiple = false, Inherited = true)]
public sealed class ExploreIgnoreAttribute : Attribute { }

/// <summary>Attaches a named sample JSON payload to an endpoint, surfaced in the discovery output
/// for the inspector UI's "drag into scenario" flow.</summary>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = true, Inherited = false)]
public sealed class ExploreSampleAttribute : Attribute
{
    public ExploreSampleAttribute(string name, string jsonPayload)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            throw new ArgumentException("Sample name cannot be empty.", nameof(name));
        }
        Name = name;
        JsonPayload = jsonPayload ?? throw new ArgumentNullException(nameof(jsonPayload));
    }

    public string Name { get; }
    public string JsonPayload { get; }
    public string? Description { get; init; }
}
