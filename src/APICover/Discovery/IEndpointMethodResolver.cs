using System.Reflection;
using APICover.Abstractions.Discovery;

namespace APICover.Discovery;

/// <summary>
/// Internal bridge from <see cref="EndpointDescriptor.Id"/> to the <see cref="MethodInfo"/>
/// that handles it. The discovery service already extracts the method while building
/// descriptors; this contract surfaces it without polluting the public DTO.
/// Used by the call-graph walker as the entry point for each endpoint's IL traversal.
/// </summary>
internal interface IEndpointMethodResolver
{
    /// <summary>Returns the handler <see cref="MethodInfo"/> for <paramref name="endpointId"/>,
    /// or <c>null</c> if the endpoint is unknown or the method couldn't be resolved (e.g. the
    /// type was unloaded between discovery and call).</summary>
    MethodInfo? Resolve(string endpointId);
}
