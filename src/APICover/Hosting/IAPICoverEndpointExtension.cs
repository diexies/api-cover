using Microsoft.AspNetCore.Routing;

namespace APICover.Hosting;

/// <summary>
/// Additional HTTP endpoint surfaces mounted under the inspector's path prefix. Sibling
/// to <see cref="UI.IAPICoverUiProvider"/> but for JSON APIs rather than UI assets.
/// Used by add-on packages (e.g. <c>APICover.Agent</c>) to plug their routes into the
/// same <c>UseEndpoints</c> pass without forking <c>UseAPICover</c>.
/// </summary>
public interface IAPICoverEndpointExtension
{
    /// <summary>Friendly identifier for diagnostics (e.g. <c>"agent"</c>).</summary>
    string Name { get; }

    /// <summary>Mount additional endpoints under the inspector's prefix.</summary>
    void MapEndpoints(IEndpointRouteBuilder endpoints, string prefix);
}
