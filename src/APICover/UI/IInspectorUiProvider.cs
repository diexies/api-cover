using Microsoft.AspNetCore.Routing;

namespace APICover.UI;

/// <summary>
/// Pluggable inspector UI surface. The core <c>APICover</c> package only ships the
/// JSON HTTP API; UIs (web SPA, terminal TUI, IDE plugin, …) live in separate provider
/// packages and register through this interface. Multiple providers may coexist.
/// </summary>
public interface IAPICoverUiProvider
{
    /// <summary>Friendly identifier for diagnostics/logging (e.g. <c>"web"</c>, <c>"terminal"</c>).</summary>
    string Name { get; }

    /// <summary>
    /// Mount the UI onto the inspector's path prefix. Implementations typically map static
    /// assets at <c>{prefix}/ui</c> or similar. Pure-host providers (e.g. terminal) may no-op
    /// and instead drive themselves from <see cref="Microsoft.Extensions.Hosting.IHostedService"/>.
    /// </summary>
    void MapUi(IEndpointRouteBuilder endpoints, string prefix);
}
