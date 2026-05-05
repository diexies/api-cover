using System.ComponentModel;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Metadata;
using Microsoft.AspNetCore.Routing;
using APICover.Abstractions.Discovery;
using APICover.Discovery;

namespace APICover.Tests.Discovery;

public class EndpointMetadataReaderTests
{
    [Fact]
    public void Empty_metadata_yields_no_enrichment()
    {
        var result = ReadInternal(Array.Empty<object>(), null);
        Assert.Null(result.Area);
        Assert.Null(result.Purpose);
        Assert.Null(result.Description);
        Assert.Empty(result.Tags);
        Assert.False(result.IsDeprecated);
        Assert.False(result.Ignored);
        Assert.Null(result.Authorization);
        Assert.Empty(result.Samples);
    }

    [Fact]
    public void ExploreEndpoint_area_overrides_class_area()
    {
        var classArea = new ExploreAreaAttribute("billing");
        var endpoint = new ExploreEndpointAttribute { Area = "user" };
        var result = ReadInternal(new object[] { endpoint }, classArea);
        Assert.Equal("user", result.Area);
    }

    [Fact]
    public void ExploreArea_method_level_overrides_class()
    {
        var classArea = new ExploreAreaAttribute("billing");
        var methodArea = new ExploreAreaAttribute("user");
        var result = ReadInternal(new object[] { methodArea }, classArea);
        Assert.Equal("user", result.Area);
    }

    [Fact]
    public void Class_area_used_when_no_method_attribute()
    {
        var classArea = new ExploreAreaAttribute("billing") { Purpose = "internal" };
        var result = ReadInternal(Array.Empty<object>(), classArea);
        Assert.Equal("billing", result.Area);
        Assert.Equal("internal", result.Purpose);
    }

    [Fact]
    public void Purpose_precedence_endpoint_over_class()
    {
        var classArea = new ExploreAreaAttribute("billing") { Purpose = "internal" };
        var endpoint = new ExploreEndpointAttribute { Purpose = "user-action" };
        var result = ReadInternal(new object[] { endpoint }, classArea);
        Assert.Equal("user-action", result.Purpose);
    }

    [Fact]
    public void ExploreIgnore_sets_ignored_flag()
    {
        var result = ReadInternal(new object[] { new ExploreIgnoreAttribute() }, null);
        Assert.True(result.Ignored);
    }

    [Fact]
    public void Tags_collected_from_endpoint_attr_and_TagsMetadata()
    {
        var endpoint = new ExploreEndpointAttribute { Tags = new[] { "users", "v2" } };
        var tags = new TagsAttribute("admin", "users");
        var result = ReadInternal(new object[] { endpoint, tags }, null);
        Assert.Equal(3, result.Tags.Count);
        Assert.Contains("users", result.Tags);
        Assert.Contains("admin", result.Tags);
        Assert.Contains("v2", result.Tags);
    }

    [Fact]
    public void Samples_passthrough()
    {
        var s1 = new ExploreSampleAttribute("a", "{}");
        var s2 = new ExploreSampleAttribute("b", "[]") { Description = "list" };
        var result = ReadInternal(new object[] { s1, s2 }, null);
        Assert.Equal(2, result.Samples.Count);
        Assert.Equal("list", result.Samples.Last().Description);
    }

    [Fact]
    public void Obsolete_marks_deprecated()
    {
        var result = ReadInternal(new object[] { new ObsoleteAttribute("dont") }, null);
        Assert.True(result.IsDeprecated);
    }

    [Fact]
    public void Description_precedence_explore_then_DescriptionAttribute()
    {
        var d = new DescriptionAttribute("from desc");
        var endpoint = new ExploreEndpointAttribute { Description = "from explore" };
        var result = ReadInternal(new object[] { d, endpoint }, null);
        Assert.Equal("from explore", result.Description);

        var result2 = ReadInternal(new object[] { d }, null);
        Assert.Equal("from desc", result2.Description);
    }

    [Fact]
    public void Authorize_attribute_populates_policies_roles_schemes()
    {
        var attr = new AuthorizeAttribute("admin")
        {
            Roles = "Admin,Owner",
            AuthenticationSchemes = "Bearer,Cookies"
        };
        var result = ReadInternal(new object[] { attr }, null);
        Assert.NotNull(result.Authorization);
        Assert.True(result.Authorization!.RequiresAuthentication);
        Assert.False(result.Authorization.AllowsAnonymous);
        Assert.Contains("admin", result.Authorization.Policies);
        Assert.Contains("Admin", result.Authorization.Roles);
        Assert.Contains("Bearer", result.Authorization.AuthenticationSchemes);
    }

    [Fact]
    public void AllowAnonymous_overrides_RequiresAuthentication()
    {
        var allow = new AllowAnonymousAttribute();
        var auth = new AuthorizeAttribute("admin");
        var result = ReadInternal(new object[] { allow, auth }, null);
        Assert.NotNull(result.Authorization);
        Assert.False(result.Authorization!.RequiresAuthentication);
        Assert.True(result.Authorization.AllowsAnonymous);
    }

    private static EndpointMetadataReader.EnrichedMetadata ReadInternal(
        IReadOnlyList<object> metadata,
        ExploreAreaAttribute? classLevelArea)
        => EndpointMetadataReader.Read(metadata, classLevelArea);
}
