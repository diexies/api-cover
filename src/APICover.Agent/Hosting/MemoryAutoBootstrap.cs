using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using APICover.Agent.Credentials;
using APICover.Agent.Engine;
using APICover.Agent.Memory;

namespace APICover.Agent.Hosting;

/// <summary>
/// On host start: if the agent is configured (Max or ApiKey credential present) and
/// the memory directory is essentially empty, kick a one-off scan run so the workspace
/// is ready by the time the user opens the UI. The scan runs in the background; failures
/// are logged but never surfaced to the user — they can always re-trigger from the UI.
/// </summary>
internal sealed class MemoryAutoBootstrap : BackgroundService
{
    private readonly IAgentCredentialStore _credentials;
    private readonly IAgentMemoryStore _memory;
    private readonly AgentRunCoordinator _coordinator;
    private readonly ILogger<MemoryAutoBootstrap> _log;

    public MemoryAutoBootstrap(
        IAgentCredentialStore credentials,
        IAgentMemoryStore memory,
        AgentRunCoordinator coordinator,
        ILogger<MemoryAutoBootstrap> log)
    {
        _credentials = credentials;
        _memory = memory;
        _coordinator = coordinator;
        _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Settle delay so app routes finish wiring + discovery cache warms before we
        // run a heavy LLM workload. 5s is plenty for a small dotnet host.
        try { await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken); }
        catch (OperationCanceledException) { return; }

        try
        {
            var stored = await _credentials.GetAsync(stoppingToken);
            if (stored is null || stored.Mode == AgentCredentialMode.Disabled)
            {
                _log.LogDebug("Memory auto-bootstrap skipped: no credential configured.");
                return;
            }

            var entries = await _memory.ListAsync(cancellationToken: stoppingToken);
            // Treat the seed `introduce.md` as effectively empty — the scaffold ships
            // with it but it doesn't reflect actual project knowledge.
            var meaningful = entries.Where(e => !string.Equals(e.Path, "introduce.md", StringComparison.OrdinalIgnoreCase)).ToArray();
            if (meaningful.Length > 0)
            {
                _log.LogDebug("Memory auto-bootstrap skipped: {Count} file(s) already exist.", meaningful.Length);
                return;
            }

            const string prompt = "Run a project scan and populate memory per the operating manual.";
            var result = _coordinator.Start(prompt, AgentRunMode.Scan);
            if (!result.Started)
            {
                _log.LogWarning("Memory auto-bootstrap could not start scan: {Reason}", result.RejectionReason);
                return;
            }
            _log.LogInformation("Memory auto-bootstrap started scan {RunId}.", result.RunId);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Memory auto-bootstrap failed. User can trigger a scan manually.");
        }
    }
}
