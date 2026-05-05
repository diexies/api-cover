using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.ApiExplorer;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using APICover.Abstractions.Discovery;
using APICover.Discovery;

namespace APICover.Tests.Discovery;

public class ApiExplorerDiscoveryServiceTests
{
    [Fact]
    public void Endpoint_with_path_query_and_body_yields_full_descriptor()
    {
        var api = new ApiDescription
        {
            HttpMethod = "POST",
            RelativePath = "users/{id}",
            ActionDescriptor = new ActionDescriptor { DisplayName = "create-user" }
        };
        api.ParameterDescriptions.Add(new ApiParameterDescription
        {
            Name = "id",
            Source = BindingSource.Path,
            Type = typeof(int),
            IsRequired = true
        });
        api.ParameterDescriptions.Add(new ApiParameterDescription
        {
            Name = "verbose",
            Source = BindingSource.Query,
            Type = typeof(bool)
        });
        api.ParameterDescriptions.Add(new ApiParameterDescription
        {
            Name = "body",
            Source = BindingSource.Body,
            Type = typeof(SamplePayload),
            IsRequired = true
        });
        api.SupportedRequestFormats.Add(new ApiRequestFormat { MediaType = "application/json" });
        api.SupportedResponseTypes.Add(new ApiResponseType
        {
            StatusCode = 201,
            Type = typeof(SamplePayload),
            ApiResponseFormats = { new ApiResponseFormat { MediaType = "application/json" } }
        });

        var svc = BuildService(api);
        var endpoints = svc.GetEndpoints();

        var ep = Assert.Single(endpoints);
        Assert.Equal("POST /users/{id}", ep.Id);
        Assert.Equal(2, ep.Parameters.Count);
        Assert.Contains(ep.Parameters, p => p.Name == "id" && p.In == ParameterLocation.Path);
        Assert.Contains(ep.Parameters, p => p.Name == "verbose" && p.In == ParameterLocation.Query);
        Assert.NotNull(ep.RequestBody);
        Assert.Single(ep.RequestBody!.Content);
        Assert.Equal("application/json", ep.RequestBody.Content[0].ContentType);
        Assert.NotNull(ep.RequestBody.Content[0].Schema);
        Assert.NotNull(ep.RequestBody.Content[0].Example);
        Assert.Single(ep.Responses);
        Assert.Equal(201, ep.Responses[0].StatusCode);
        Assert.True(ep.HasBody);
    }

    [Fact]
    public void ExploreIgnore_metadata_filters_endpoint_out()
    {
        var api = new ApiDescription
        {
            HttpMethod = "GET",
            RelativePath = "secret",
            ActionDescriptor = new ActionDescriptor()
        };
        api.ActionDescriptor.EndpointMetadata = new List<object> { new ExploreIgnoreAttribute() };

        var svc = BuildService(api);
        Assert.Empty(svc.GetEndpoints());
    }

    [Fact]
    public void ExploreEndpoint_metadata_propagates_to_descriptor()
    {
        var api = new ApiDescription
        {
            HttpMethod = "GET",
            RelativePath = "u",
            ActionDescriptor = new ActionDescriptor()
        };
        api.ActionDescriptor.EndpointMetadata = new List<object>
        {
            new ExploreEndpointAttribute
            {
                Area = "user",
                Purpose = "user-action",
                Description = "List users",
                DisplayName = "List users",
                Tags = new[] { "users", "v1" }
            },
            new ExploreSampleAttribute("default", "{}")
        };

        var svc = BuildService(api);
        var ep = Assert.Single(svc.GetEndpoints());
        Assert.Equal("user", ep.Area);
        Assert.Equal("user-action", ep.Purpose);
        Assert.Equal("List users", ep.Description);
        Assert.Equal("List users", ep.DisplayName);
        Assert.Contains("users", ep.Tags);
        Assert.Single(ep.Samples);
    }

    [Fact]
    public void RequestBody_falls_back_to_application_json_when_no_supported_format_declared()
    {
        var api = new ApiDescription
        {
            HttpMethod = "POST",
            RelativePath = "x",
            ActionDescriptor = new ActionDescriptor()
        };
        api.ParameterDescriptions.Add(new ApiParameterDescription
        {
            Name = "body",
            Source = BindingSource.Body,
            Type = typeof(SamplePayload)
        });

        var svc = BuildService(api);
        var ep = Assert.Single(svc.GetEndpoints());
        Assert.NotNull(ep.RequestBody);
        Assert.Equal("application/json", ep.RequestBody!.Content[0].ContentType);
    }

    [Fact]
    public void Source_kind_is_unknown_for_bare_action_descriptor()
    {
        var api = new ApiDescription
        {
            HttpMethod = "GET",
            RelativePath = "x",
            ActionDescriptor = new ActionDescriptor()
        };
        var svc = BuildService(api);
        var ep = Assert.Single(svc.GetEndpoints());
        Assert.Equal(EndpointSourceKind.Unknown, ep.Source);
    }

    [Fact]
    public void Cache_returns_same_instance_when_api_version_unchanged()
    {
        var api = new ApiDescription
        {
            HttpMethod = "GET",
            RelativePath = "x",
            ActionDescriptor = new ActionDescriptor()
        };
        var provider = new FakeProvider(new ApiDescriptionGroupCollection(
            new[] { new ApiDescriptionGroup(null, new[] { api }) }, version: 1));
        var svc = new ApiExplorerDiscoveryService(provider);

        var first = svc.GetEndpoints();
        var second = svc.GetEndpoints();
        Assert.Same(first, second);
    }

    [Fact]
    public void Cache_invalidates_when_api_version_increments()
    {
        var firstApi = new ApiDescription
        {
            HttpMethod = "GET",
            RelativePath = "x",
            ActionDescriptor = new ActionDescriptor()
        };
        var provider = new FakeProvider(new ApiDescriptionGroupCollection(
            new[] { new ApiDescriptionGroup(null, new[] { firstApi }) }, version: 1));
        var svc = new ApiExplorerDiscoveryService(provider);
        var first = svc.GetEndpoints();
        Assert.Single(first);

        var secondApi = new ApiDescription
        {
            HttpMethod = "POST",
            RelativePath = "y",
            ActionDescriptor = new ActionDescriptor()
        };
        provider.ApiDescriptionGroupsRef = new ApiDescriptionGroupCollection(
            new[] { new ApiDescriptionGroup(null, new[] { firstApi, secondApi }) }, version: 2);

        var second = svc.GetEndpoints();
        Assert.NotSame(first, second);
        Assert.Equal(2, second.Count);
    }

    private static ApiExplorerDiscoveryService BuildService(params ApiDescription[] apis)
    {
        var group = new ApiDescriptionGroup(groupName: null, items: apis);
        var collection = new ApiDescriptionGroupCollection(new[] { group }, version: 1);
        return new ApiExplorerDiscoveryService(new FakeProvider(collection));
    }

    private sealed class FakeProvider : IApiDescriptionGroupCollectionProvider
    {
        public FakeProvider(ApiDescriptionGroupCollection collection)
        {
            ApiDescriptionGroupsRef = collection;
        }
        public ApiDescriptionGroupCollection ApiDescriptionGroupsRef { get; set; }
        public ApiDescriptionGroupCollection ApiDescriptionGroups => ApiDescriptionGroupsRef;
    }

    public sealed record SamplePayload(string Name, int Age);
}
