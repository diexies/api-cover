using System.ComponentModel;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Metadata;
using Microsoft.AspNetCore.Routing;
using APICover.Abstractions.Discovery;

namespace APICover.Discovery;

/// <summary>
/// Reads enrichment metadata (Authorize, Tags, Produces, Accepts, Summary, Description,
/// Obsolete, ExcludeFromDescription, and the Utopia <c>Explore*</c> attributes) off an
/// endpoint's metadata collection. Works uniformly for controllers and minimal API.
/// </summary>
internal static class EndpointMetadataReader
{
    public sealed record EnrichedMetadata(
        string? Area,
        string? Purpose,
        string? Description,
        string? DisplayName,
        IReadOnlyList<string> Tags,
        bool IsDeprecated,
        bool ExcludeFromDescription,
        bool Ignored,
        EndpointAuthRequirement? Authorization,
        IReadOnlyList<EndpointSample> Samples,
        IReadOnlyList<IProducesResponseTypeMetadata> ProducesResponses,
        IAcceptsMetadata? Accepts);

    public static EnrichedMetadata Read(IReadOnlyList<object> metadata, ExploreAreaAttribute? classLevelArea)
    {
        var ignored = metadata.OfType<ExploreIgnoreAttribute>().Any();
        var endpointAttr = metadata.OfType<ExploreEndpointAttribute>().LastOrDefault();
        var methodAreaAttr = metadata.OfType<ExploreAreaAttribute>().LastOrDefault();

        var area = endpointAttr?.Area
                   ?? methodAreaAttr?.Area
                   ?? classLevelArea?.Area;

        var purpose = endpointAttr?.Purpose
                      ?? methodAreaAttr?.Purpose
                      ?? classLevelArea?.Purpose;

        // Description precedence: ExploreEndpoint → ExploreArea (class/method) →
        // [Description] → IEndpointDescriptionMetadata → IEndpointSummaryMetadata.
        var description = endpointAttr?.Description
                          ?? methodAreaAttr?.Description
                          ?? classLevelArea?.Description
                          ?? metadata.OfType<DescriptionAttribute>().FirstOrDefault()?.Description
                          ?? metadata.OfType<IEndpointDescriptionMetadata>().FirstOrDefault()?.Description
                          ?? metadata.OfType<IEndpointSummaryMetadata>().FirstOrDefault()?.Summary;

        var displayName = endpointAttr?.DisplayName;

        var tags = new List<string>();
        if (endpointAttr is not null) tags.AddRange(endpointAttr.Tags);
        foreach (var t in metadata.OfType<ITagsMetadata>())
        {
            tags.AddRange(t.Tags);
        }

        var isDeprecated = metadata.OfType<ObsoleteAttribute>().Any();
        var exclude = metadata.OfType<IExcludeFromDescriptionMetadata>().Any(m => m.ExcludeFromDescription);

        var samples = metadata.OfType<ExploreSampleAttribute>()
            .Select(s => new EndpointSample
            {
                Name = s.Name,
                JsonPayload = s.JsonPayload,
                Description = s.Description
            })
            .ToList();

        var auth = ReadAuthorization(metadata);

        var produces = metadata.OfType<IProducesResponseTypeMetadata>().ToList();
        var accepts = metadata.OfType<IAcceptsMetadata>().LastOrDefault();

        return new EnrichedMetadata(
            area,
            purpose,
            description,
            displayName,
            tags.Count == 0 ? Array.Empty<string>() : tags.Distinct().ToArray(),
            isDeprecated,
            exclude,
            ignored,
            auth,
            samples.Count == 0 ? Array.Empty<EndpointSample>() : samples,
            produces,
            accepts);
    }

    private static EndpointAuthRequirement? ReadAuthorization(IReadOnlyList<object> metadata)
    {
        var allowAnonymous = metadata.OfType<IAllowAnonymous>().Any();
        var authorize = metadata.OfType<IAuthorizeData>().ToList();

        if (!allowAnonymous && authorize.Count == 0)
        {
            return null;
        }

        var policies = authorize
            .Select(a => a.Policy)
            .Where(p => !string.IsNullOrWhiteSpace(p))
            .Select(p => p!)
            .Distinct()
            .ToArray();

        var roles = authorize
            .SelectMany(a => (a.Roles ?? string.Empty).Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            .Distinct()
            .ToArray();

        var schemes = authorize
            .SelectMany(a => (a.AuthenticationSchemes ?? string.Empty).Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            .Distinct()
            .ToArray();

        return new EndpointAuthRequirement
        {
            RequiresAuthentication = authorize.Count > 0 && !allowAnonymous,
            AllowsAnonymous = allowAnonymous,
            Policies = policies,
            Roles = roles,
            AuthenticationSchemes = schemes
        };
    }
}
