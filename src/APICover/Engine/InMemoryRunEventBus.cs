using System.Collections.Concurrent;
using System.Threading.Channels;
using APICover.Abstractions.Models;
using APICover.Abstractions.Services;

namespace APICover.Engine;

/// <summary>
/// In-process <see cref="IRunEventBus"/>. One bounded <see cref="Channel{T}"/> per (run, subscriber)
/// pair: publishers fan out non-blockingly, subscribers consume independently. Channels complete
/// after a <see cref="RunEventType.RunFinished"/> event so SSE clients see EOF naturally.
/// </summary>
public sealed class InMemoryRunEventBus : IRunEventBus
{
    private readonly ConcurrentDictionary<string, List<Channel<RunEvent>>> _subs = new();
    private readonly object _subsLock = new();

    public void Publish(string runId, RunEvent @event)
    {
        ArgumentException.ThrowIfNullOrEmpty(runId);
        ArgumentNullException.ThrowIfNull(@event);

        if (!_subs.TryGetValue(runId, out var channels)) return;

        Channel<RunEvent>[] snapshot;
        lock (_subsLock)
        {
            snapshot = channels.ToArray();
        }

        foreach (var ch in snapshot)
        {
            // TryWrite returns false if bounded channel is full or already complete; either way drop.
            ch.Writer.TryWrite(@event);
            if (@event.Type == RunEventType.RunFinished)
            {
                ch.Writer.TryComplete();
            }
        }
    }

    public async IAsyncEnumerable<RunEvent> SubscribeAsync(
        string runId,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrEmpty(runId);

        var channel = Channel.CreateBounded<RunEvent>(new BoundedChannelOptions(capacity: 256)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
            SingleWriter = false
        });

        var list = _subs.GetOrAdd(runId, _ => new List<Channel<RunEvent>>());
        lock (_subsLock)
        {
            list.Add(channel);
        }

        try
        {
            await foreach (var evt in channel.Reader.ReadAllAsync(cancellationToken).ConfigureAwait(false))
            {
                yield return evt;
            }
        }
        finally
        {
            lock (_subsLock)
            {
                list.Remove(channel);
                if (list.Count == 0)
                {
                    _subs.TryRemove(runId, out _);
                }
            }
            channel.Writer.TryComplete();
        }
    }
}
