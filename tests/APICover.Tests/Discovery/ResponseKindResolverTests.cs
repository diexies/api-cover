using APICover.Abstractions.Discovery;
using APICover.Discovery;

namespace APICover.Tests.Discovery;

public class ResponseKindResolverTests
{
    [Theory]
    [InlineData("text/event-stream", ResponseKind.Sse)]
    [InlineData("application/json", ResponseKind.Json)]
    [InlineData("application/json; charset=utf-8", ResponseKind.Json)]
    [InlineData("application/vnd.api+json", ResponseKind.Json)]
    [InlineData("text/json", ResponseKind.Json)]
    [InlineData("application/x-ndjson", ResponseKind.Ndjson)]
    [InlineData("application/jsonl", ResponseKind.Ndjson)]
    [InlineData("text/plain", ResponseKind.Text)]
    [InlineData("text/html", ResponseKind.Text)]
    [InlineData("application/octet-stream", ResponseKind.Binary)]
    [InlineData("image/png", ResponseKind.Binary)]
    [InlineData("application/pdf", ResponseKind.Binary)]
    [InlineData("video/mp4", ResponseKind.Binary)]
    [InlineData(null, ResponseKind.Unknown)]
    [InlineData("", ResponseKind.Unknown)]
    [InlineData("application/weird-thing", ResponseKind.Unknown)]
    public void FromContentType_classifies_correctly(string? contentType, ResponseKind expected)
    {
        Assert.Equal(expected, ResponseKindResolver.FromContentType(contentType));
    }

    [Fact]
    public void IAsyncEnumerable_return_type_yields_Sse()
    {
        var kind = ResponseKindResolver.Resolve(typeof(IAsyncEnumerable<string>), Array.Empty<EndpointMediaType>());
        Assert.Equal(ResponseKind.Sse, kind);
    }

    [Fact]
    public void Task_of_IAsyncEnumerable_unwraps()
    {
        var kind = ResponseKindResolver.Resolve(typeof(Task<IAsyncEnumerable<int>>), Array.Empty<EndpointMediaType>());
        Assert.Equal(ResponseKind.Sse, kind);
    }

    [Fact]
    public void Stream_return_type_yields_Stream()
    {
        var kind = ResponseKindResolver.Resolve(typeof(System.IO.Stream), Array.Empty<EndpointMediaType>());
        Assert.Equal(ResponseKind.Stream, kind);
    }

    [Fact]
    public void Explicit_sse_content_type_overrides_clr_type()
    {
        var media = new[] { new EndpointMediaType { ContentType = "text/event-stream", Kind = ResponseKind.Sse } };
        var kind = ResponseKindResolver.Resolve(typeof(string), media);
        Assert.Equal(ResponseKind.Sse, kind);
    }

    [Fact]
    public void Json_content_type_with_pojo_return_yields_Json()
    {
        var media = new[] { new EndpointMediaType { ContentType = "application/json", Kind = ResponseKind.Json } };
        var kind = ResponseKindResolver.Resolve(typeof(string), media);
        Assert.Equal(ResponseKind.Json, kind);
    }
}
