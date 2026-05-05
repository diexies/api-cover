using Microsoft.Extensions.DependencyInjection;
using APICover.Abstractions.Services;

namespace APICover.Discovery.CallGraph;

/// <summary>
/// Default <see cref="IServiceCollectionSnapshot"/> implementation. Holds a reference to the
/// host's <see cref="IServiceCollection"/> captured during <c>AddAPICover</c> and
/// enumerates lazily on first access — by which time <c>BuildServiceProvider</c> has run
/// and registrations are stable.
/// </summary>
internal sealed class ServiceCollectionSnapshot : IServiceCollectionSnapshot
{
    private readonly IServiceCollection _services;
    private readonly Lazy<IReadOnlyList<ServiceRegistration>> _registrations;

    private ServiceCollectionSnapshot(IServiceCollection services)
    {
        _services = services;
        _registrations = new Lazy<IReadOnlyList<ServiceRegistration>>(BuildRegistrations);
    }

    /// <summary>Capture a snapshot. Enumeration is deferred to first read.</summary>
    public static IServiceCollectionSnapshot Build(IServiceCollection services) =>
        new ServiceCollectionSnapshot(services);

    public IReadOnlyList<ServiceRegistration> Registrations => _registrations.Value;

    public IReadOnlyList<ServiceRegistration> ResolveImplementations(Type serviceType)
    {
        var registrations = _registrations.Value;
        var hits = new List<ServiceRegistration>();
        foreach (var r in registrations)
        {
            if (r.ServiceType == serviceType)
            {
                hits.Add(r);
                continue;
            }
            // Closed-generic match against open-generic registration.
            if (serviceType.IsGenericType && r.ServiceType.IsGenericTypeDefinition
                && r.ServiceType == serviceType.GetGenericTypeDefinition())
            {
                hits.Add(r);
            }
        }
        return hits;
    }

    private IReadOnlyList<ServiceRegistration> BuildRegistrations()
    {
        var list = new List<ServiceRegistration>(_services.Count);
        foreach (var d in _services)
        {
            list.Add(new ServiceRegistration(
                ServiceType: d.ServiceType,
                ImplementationType: d.ImplementationType,
                Lifetime: d.Lifetime,
                HasFactory: d.ImplementationFactory is not null,
                ImplementationInstanceType: d.ImplementationInstance?.GetType()));
        }
        return list;
    }
}
