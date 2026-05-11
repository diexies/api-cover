using System.Collections.Concurrent;

namespace APICover.Agent.Engine;

internal sealed class InMemoryAgentRunStore : IAgentRunStore
{
    private const int MaxRecords = 200;
    private readonly ConcurrentDictionary<string, AgentRunRecord> _byId = new();
    private readonly ConcurrentQueue<string> _order = new();

    public void Save(AgentRunRecord record)
    {
        _byId[record.Id] = record;
        _order.Enqueue(record.Id);
        while (_order.Count > MaxRecords && _order.TryDequeue(out var oldest))
        {
            _byId.TryRemove(oldest, out _);
        }
    }

    public AgentRunRecord? Get(string id) => _byId.TryGetValue(id, out var record) ? record : null;

    public IReadOnlyList<AgentRunRecord> List(int take = 50) =>
        _byId.Values.OrderByDescending(r => r.StartedAt).Take(take).ToList();
}
