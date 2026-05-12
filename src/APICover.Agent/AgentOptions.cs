namespace APICover.Agent;

/// <summary>
/// Configuration for the embedded Claude agent. Caps are applied per workspace and per
/// individual run; whichever is reached first aborts the in-flight Anthropic round-trip.
/// </summary>
public sealed class AgentOptions
{
    /// <summary>Anthropic model id used for both Max bridge and direct API calls.</summary>
    public string Model { get; set; } = "claude-opus-4-7-20251101";

    /// <summary>Combined input + output tokens permitted per agent run before abort.</summary>
    public int MaxTokensPerRun { get; set; } = 60_000;

    /// <summary>Hard cap on tool dispatches per run (kill switch separate from token budget).</summary>
    public int MaxToolCallsPerRun { get; set; } = 40;

    /// <summary>Concurrent runs allowed per workspace. Excess are rejected with 429.</summary>
    public int MaxConcurrentRunsPerWorkspace { get; set; } = 2;

    /// <summary>Sliding-window cap on runs initiated within the last hour.</summary>
    public int MaxRunsPerHour { get; set; } = 20;

    /// <summary>Default per-workspace daily dollar cap when the credential record doesn't carry
    /// its own. Null = no global cap (rely on per-credential cap; if neither is set, the
    /// agent refuses to start).</summary>
    public decimal? MaxDollarsPerDay { get; set; } = 5.00m;

    /// <summary>Permit the Max-subscription auth path (claude CLI bridge).</summary>
    public bool AllowMaxSubscription { get; set; } = true;

    /// <summary>Permit direct API key auth.</summary>
    public bool AllowApiKey { get; set; } = true;

    /// <summary>Anthropic API base URL. Override only for testing against a stub.</summary>
    public Uri AnthropicBaseAddress { get; set; } = new("https://api.anthropic.com/");

    /// <summary>Anthropic API version header sent on every request.</summary>
    public string AnthropicVersion { get; set; } = "2023-06-01";

    /// <summary>Seconds before a single Anthropic request is cancelled. Note: in Max mode
    /// this also caps the CLI subprocess lifetime — scenario inference + tool loops can
    /// easily exceed 2 minutes on large APIs.</summary>
    public int RequestTimeoutSeconds { get; set; } = 600;

    /// <summary>
    /// Filesystem root the agent's persistent memory lives under. Resolved at boot:
    /// when null, defaults to <c>{ContentRoot}/docs/apicover-agent</c>. Memory files
    /// (INTRODUCE.md, INDEX.md, per-area summaries) are written here so they travel
    /// with the project's git history. Override to a custom relative or absolute path.
    /// </summary>
    public string? MemoryRoot { get; set; }

    /// <summary>Maximum size of a single memory file (bytes). Defaults to 256 KB —
    /// the agent should not write multi-megabyte payloads under any circumstance.</summary>
    public int MaxMemoryFileBytes { get; set; } = 256 * 1024;

    /// <summary>
    /// Filesystem root for persistent run sessions (one JSON file per run). Default
    /// resolves to <c>{ContentRoot}/docs/apicover-agent-sessions</c>. Sessions travel
    /// with the project's git history alongside the memory.
    /// </summary>
    public string? SessionsRoot { get; set; }

    /// <summary>
    /// Filesystem path for the persisted credential record. Default resolves to
    /// <c>{ContentRoot}/docs/apicover-agent/credentials.json</c>. The encrypted API
    /// key is opaque ciphertext (Data Protection); plaintext is never written.
    /// </summary>
    public string? CredentialsPath { get; set; }
}
