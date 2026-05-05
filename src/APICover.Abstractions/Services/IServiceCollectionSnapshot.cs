using Microsoft.Extensions.DependencyInjection;

namespace APICover.Abstractions.Services;

/// <summary>
/// Read-only view of the host's <see cref="IServiceCollection"/> registrations, captured at
/// <c>AddAPICover</c> time and enumerated lazily so reads see the post-build state.
/// Used by the IL walker to resolve <c>callvirt IUserService.GetById</c> to its concrete
/// implementation type — without this, the walker would stop at every interface boundary.
/// </summary>
public interface IServiceCollectionSnapshot
{
    /// <summary>All captured registrations.</summary>
    IReadOnlyList<ServiceRegistration> Registrations { get; }

    /// <summary>Look up registrations matching a service type. Closed-generic services match
    /// against open-generic registrations as well (e.g. <c>IRepo&lt;User&gt;</c> matches
    /// <c>typeof(IRepo&lt;&gt;)</c>).</summary>
    IReadOnlyList<ServiceRegistration> ResolveImplementations(Type serviceType);
}

/// <summary>One <see cref="ServiceDescriptor"/> captured as immutable POCO.</summary>
public sealed record ServiceRegistration(
    Type ServiceType,
    Type? ImplementationType,
    ServiceLifetime Lifetime,
    bool HasFactory,
    Type? ImplementationInstanceType);
