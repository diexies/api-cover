namespace APICover.Agent.Engine;

/// <summary>In-memory record of recent agent runs. Bounded to recent N runs to keep the
/// process footprint small; the UI fetches live state via SSE, not via list lookups.</summary>
public interface IAgentRunStore
{
    void Save(AgentRunRecord record);
    AgentRunRecord? Get(string id);
    IReadOnlyList<AgentRunRecord> List(int take = 50);
}
