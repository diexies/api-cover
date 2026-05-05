using Microsoft.AspNetCore.Builder;
using APICover.Abstractions.Discovery;

namespace APICover.Discovery;

/// <summary>
/// Fluent helpers that attach Utopia <c>Explore*</c> metadata to minimal-API endpoints,
/// route groups, or controller convention builders. Generic on <see cref="IEndpointConventionBuilder"/>
/// so the same call works for <c>RouteHandlerBuilder</c>, <c>RouteGroupBuilder</c>, and friends.
/// </summary>
public static class ExploreEndpointBuilderExtensions
{
    /// <summary>Attaches an <see cref="ExploreEndpointAttribute"/> to the endpoint(s) being built.</summary>
    public static TBuilder ExploreEndpoint<TBuilder>(this TBuilder builder,
        string? area = null,
        string? purpose = null,
        string? description = null,
        string? displayName = null,
        params string[] tags)
        where TBuilder : IEndpointConventionBuilder
    {
        ArgumentNullException.ThrowIfNull(builder);
        return builder.WithMetadata(new ExploreEndpointAttribute
        {
            Area = area,
            Purpose = purpose,
            Description = description,
            DisplayName = displayName,
            Tags = tags ?? Array.Empty<string>()
        });
    }

    /// <summary>Marks the endpoint(s) as ignored by Utopia discovery.</summary>
    public static TBuilder ExploreIgnore<TBuilder>(this TBuilder builder)
        where TBuilder : IEndpointConventionBuilder
    {
        ArgumentNullException.ThrowIfNull(builder);
        return builder.WithMetadata(new ExploreIgnoreAttribute());
    }

    /// <summary>Attaches a named JSON sample payload, surfaced to the inspector UI.</summary>
    public static TBuilder ExploreSample<TBuilder>(this TBuilder builder, string name, string jsonPayload, string? description = null)
        where TBuilder : IEndpointConventionBuilder
    {
        ArgumentNullException.ThrowIfNull(builder);
        return builder.WithMetadata(new ExploreSampleAttribute(name, jsonPayload) { Description = description });
    }

    /// <summary>Tags the endpoint(s) with a logical area (no Purpose).</summary>
    public static TBuilder ExploreArea<TBuilder>(this TBuilder builder, string area, string? purpose = null, string? description = null)
        where TBuilder : IEndpointConventionBuilder
    {
        ArgumentNullException.ThrowIfNull(builder);
        return builder.WithMetadata(new ExploreAreaAttribute(area)
        {
            Purpose = purpose,
            Description = description
        });
    }
}
