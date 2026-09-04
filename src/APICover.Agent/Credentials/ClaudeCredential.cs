namespace APICover.Agent.Credentials;

/// <summary>Which LLM vendor an API-key credential targets. The agent's internal message
/// model stays Anthropic-shaped regardless; non-Anthropic providers translate at their
/// client boundary.</summary>
public enum AgentProvider
{
    Anthropic = 0,
    OpenAI = 1
}

/// <summary>Credential modes the agent accepts. The provider returns one of these.</summary>
public abstract record ClaudeCredential;

/// <summary>Direct API key for <see cref="Provider"/>. <see cref="DailyDollarCap"/> is the
/// per-credential budget; the engine combines it with <see cref="AgentOptions.MaxDollarsPerDay"/>
/// and enforces whichever is lower. <see cref="Model"/> optionally overrides the
/// provider-default model from AgentOptions.</summary>
public sealed record ApiKeyCredential(
    string Key,
    decimal? DailyDollarCap,
    AgentProvider Provider = AgentProvider.Anthropic,
    string? Model = null) : ClaudeCredential;

/// <summary>Max subscription path: spawn the locally-installed <c>claude</c> CLI as a child
/// process and pipe prompts through it. Cap is governed by AgentOptions only — Max quota
/// is metered by Anthropic itself.</summary>
public sealed record MaxSubscriptionCredential(string CliPath) : ClaudeCredential;
