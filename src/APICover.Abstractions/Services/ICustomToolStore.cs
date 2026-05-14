using APICover.Abstractions.Models;

namespace APICover.Abstractions.Services;

/// <summary>
/// Persists user-defined custom MCP tools. Implementations cache in memory and write through
/// to durable storage so the catalogue survives process restarts. Tools are keyed by their
/// <see cref="CustomToolDefinition.Name"/>.
/// </summary>
public interface ICustomToolStore
{
    Task<IReadOnlyList<CustomToolDefinition>> ListAsync(CancellationToken cancellationToken = default);
    Task<CustomToolDefinition?> GetAsync(string name, CancellationToken cancellationToken = default);
    Task SaveAsync(CustomToolDefinition definition, CancellationToken cancellationToken = default);
    Task DeleteAsync(string name, CancellationToken cancellationToken = default);

    /// <summary>Absolute filesystem path where definitions are persisted.</summary>
    string Root { get; }
}
