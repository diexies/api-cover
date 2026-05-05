using APICover.Discovery;

namespace APICover.Tests.Discovery;

public class AreaConventionResolverTests
{
    [Theory]
    [InlineData("UsersController", "users")]
    [InlineData("Users", "users")]
    [InlineData("BillingV2Controller", "billing-v2")]
    [InlineData("OAuthCallbacksController", "o-auth-callbacks")]
    [InlineData("APIController", "api")]
    [InlineData("HTTPProxyController", "http-proxy")]
    [InlineData("AccountController", "account")]
    [InlineData("WeatherForecastController", "weather-forecast")]
    public void Conventional_controller_names_map_to_kebab_case(string input, string expected)
    {
        Assert.Equal(expected, AreaConventionResolver.FromControllerName(input));
    }

    [Fact]
    public void Null_or_whitespace_returns_null()
    {
        Assert.Null(AreaConventionResolver.FromControllerName(null));
        Assert.Null(AreaConventionResolver.FromControllerName(""));
        Assert.Null(AreaConventionResolver.FromControllerName("   "));
    }

    [Fact]
    public void Bare_Controller_returns_null()
    {
        Assert.Null(AreaConventionResolver.FromControllerName("Controller"));
    }
}
