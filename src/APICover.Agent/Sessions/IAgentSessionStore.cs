namespace APICover.Agent.Sessions;

/// <summary>
/// Persistent per-run session storage. Default impl writes one JSON file per run under
/// <c>{ContentRoot}/docs/apicover-agent-sessions/{yyyy-MM-dd}/{runId}.json</c>; the
/// directory ships with the host project's git history so timelines survive redeploys
/// and travel with the repo.
/// </summary>
public interface IAgentSessionStore
{
    /// <summary>Absolute filesystem root, for diagnostics + UI display.</summary>
    string RootPath { get; }

    Task SaveAsync(SessionDoc session, CancellationToken cancellationToken = default);

    Task<SessionDoc?> GetAsync(string id, CancellationToken cancellationToken = default);

    Task<IReadOnlyList<SessionSummary>> ListAsync(int take = 50, CancellationToken cancellationToken = default);

    Task DeleteAsync(string id, CancellationToken cancellationToken = default);
}
