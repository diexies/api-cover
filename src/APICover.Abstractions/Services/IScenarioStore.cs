using APICover.Abstractions.Models;

namespace APICover.Abstractions.Services;

/// <summary>Persistence for scenarios.</summary>
public interface IScenarioStore
{
    Task<IReadOnlyList<Scenario>> ListAsync(CancellationToken cancellationToken = default);

    Task<Scenario?> GetAsync(string id, CancellationToken cancellationToken = default);

    Task SaveAsync(Scenario scenario, CancellationToken cancellationToken = default);

    Task DeleteAsync(string id, CancellationToken cancellationToken = default);
}

/// <summary>Persistence for runs.</summary>
public interface IRunStore
{
    Task<IReadOnlyList<Run>> ListAsync(string? scenarioId = null, int take = 50, CancellationToken cancellationToken = default);

    Task<Run?> GetAsync(string id, CancellationToken cancellationToken = default);

    Task SaveAsync(Run run, CancellationToken cancellationToken = default);

    Task DeleteAsync(string id, CancellationToken cancellationToken = default);
}
