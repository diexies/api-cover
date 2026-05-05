using System.Collections.Concurrent;
using APICover.Abstractions.Discovery;
using APICover.Abstractions.Models;
using APICover.Abstractions.Services;

namespace APICover.Storage;

/// <summary>In-memory <see cref="IScenarioStore"/> used as the default when no
/// persistent provider is registered. Suitable for development and testing.</summary>
public sealed class InMemoryScenarioStore : IScenarioStore
{
    private readonly ConcurrentDictionary<string, Scenario> _scenarios = new();

    public Task<IReadOnlyList<Scenario>> ListAsync(CancellationToken cancellationToken = default) =>
        Task.FromResult<IReadOnlyList<Scenario>>(_scenarios.Values.OrderBy(s => s.Name).ToList());

    public Task<Scenario?> GetAsync(string id, CancellationToken cancellationToken = default) =>
        Task.FromResult(_scenarios.TryGetValue(id, out var s) ? s : null);

    public Task SaveAsync(Scenario scenario, CancellationToken cancellationToken = default)
    {
        scenario.UpdatedAt = DateTimeOffset.UtcNow;
        _scenarios[scenario.Id] = scenario;
        return Task.CompletedTask;
    }

    public Task DeleteAsync(string id, CancellationToken cancellationToken = default)
    {
        _scenarios.TryRemove(id, out _);
        return Task.CompletedTask;
    }
}

/// <summary>In-memory <see cref="IRunStore"/> used as the default when no persistent
/// provider is registered. Suitable for development and testing.</summary>
public sealed class InMemoryRunStore : IRunStore
{
    private readonly ConcurrentDictionary<string, Run> _runs = new();

    public Task<IReadOnlyList<Run>> ListAsync(string? scenarioId = null, int take = 50, CancellationToken cancellationToken = default)
    {
        var query = _runs.Values.AsEnumerable();
        if (scenarioId is not null)
        {
            query = query.Where(r => r.ScenarioId == scenarioId);
        }
        return Task.FromResult<IReadOnlyList<Run>>(
            query.OrderByDescending(r => r.StartedAt).Take(take).ToList());
    }

    public Task<Run?> GetAsync(string id, CancellationToken cancellationToken = default) =>
        Task.FromResult(_runs.TryGetValue(id, out var r) ? r : null);

    public Task SaveAsync(Run run, CancellationToken cancellationToken = default)
    {
        _runs[run.Id] = run;
        return Task.CompletedTask;
    }

    public Task DeleteAsync(string id, CancellationToken cancellationToken = default)
    {
        _runs.TryRemove(id, out _);
        return Task.CompletedTask;
    }
}

/// <summary>In-memory <see cref="ICallGraphStore"/> used as the default when no persistent
/// provider is registered. Suitable for development; production deployments may prefer an
/// EF-backed implementation that survives restarts.</summary>
public sealed class InMemoryCallGraphStore : ICallGraphStore
{
    private readonly ConcurrentDictionary<string, CallGraphNode> _graphs = new();

    public Task<CallGraphNode?> GetAsync(string endpointId, CancellationToken cancellationToken = default) =>
        Task.FromResult(_graphs.TryGetValue(endpointId, out var g) ? g : null);

    public Task SaveAsync(CallGraphNode graph, CancellationToken cancellationToken = default)
    {
        _graphs[graph.EndpointId] = graph;
        return Task.CompletedTask;
    }

    public Task<IReadOnlyList<CallGraphNode>> ListAsync(CancellationToken cancellationToken = default) =>
        Task.FromResult<IReadOnlyList<CallGraphNode>>(_graphs.Values.OrderBy(g => g.EndpointId).ToList());

    public Task DeleteAllAsync(CancellationToken cancellationToken = default)
    {
        _graphs.Clear();
        return Task.CompletedTask;
    }
}
