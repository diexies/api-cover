namespace APICover.Agent.Credentials;

/// <summary>Credential modes the agent accepts. The provider returns one of these.</summary>
public abstract record ClaudeCredential;

/// <summary>Direct Anthropic API key. <see cref="DailyDollarCap"/> is the per-credential
/// budget; the engine combines it with <see cref="AgentOptions.MaxDollarsPerDay"/> and
/// enforces whichever is lower.</summary>
public sealed record ApiKeyCredential(string Key, decimal? DailyDollarCap) : ClaudeCredential;

/// <summary>Max subscription path: spawn the locally-installed <c>claude</c> CLI as a child
/// process and pipe prompts through it. Cap is governed by AgentOptions only — Max quota
/// is metered by Anthropic itself.</summary>
public sealed record MaxSubscriptionCredential(string CliPath) : ClaudeCredential;
