using System.Text.Json;
using APICover.Abstractions.Models;
using APICover.Abstractions.Validation;

namespace APICover.Tests.Validation;

public class CustomToolValidatorTests
{
    private static JsonElement Schema(string json) => JsonDocument.Parse(json).RootElement.Clone();

    private static CustomToolDefinition Good() => new()
    {
        Name = "users.fetch",
        Description = "Fetch a user by id.",
        WhenTriggered = "user asks to look up a user record.",
        Method = "GET",
        UrlTemplate = "/api/users/{{id}}",
        ParamsSchema = Schema("""{"properties":{"id":{"type":"string"}},"required":["id"]}"""),
    };

    [Fact]
    public void HappyPathValidates()
    {
        var r = CustomToolValidator.Validate(Good());
        Assert.True(r.IsValid, string.Join("; ", r.Errors));
    }

    [Theory]
    [InlineData("AB")]              // too short
    [InlineData("UPPER")]           // uppercase
    [InlineData("has space")]       // space
    [InlineData("has/slash")]       // slash
    public void RejectsBadName(string name)
    {
        var def = Good();
        def.Name = name;
        var r = CustomToolValidator.Validate(def);
        Assert.False(r.IsValid);
    }

    [Theory]
    [InlineData("http://evil.com/x")]
    [InlineData("https://evil.com")]
    [InlineData("//evil.com")]
    [InlineData("../etc/passwd")]
    [InlineData("/api/../../etc")]
    public void RejectsSsrfUrls(string url)
    {
        var def = Good();
        def.UrlTemplate = url;
        var r = CustomToolValidator.Validate(def);
        Assert.False(r.IsValid);
    }

    [Fact]
    public void RejectsInvalidMethod()
    {
        var def = Good();
        def.Method = "TRACE";
        var r = CustomToolValidator.Validate(def);
        Assert.False(r.IsValid);
    }

    [Fact]
    public void RejectsNonObjectParamsSchema()
    {
        var def = Good();
        def.ParamsSchema = Schema("[]");
        var r = CustomToolValidator.Validate(def);
        Assert.False(r.IsValid);
    }

    [Fact]
    public void AcceptsPlaceholdersInUrl()
    {
        var def = Good();
        def.UrlTemplate = "/api/{{a}}/foo/{{b}}";
        var r = CustomToolValidator.Validate(def);
        Assert.True(r.IsValid, string.Join("; ", r.Errors));
    }
}
