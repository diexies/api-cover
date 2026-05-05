using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Json.Logic;
using APICover.Abstractions.Models;
using APICover.Abstractions.Services;

namespace APICover.Engine;

/// <summary>
/// Reads an HTTP streaming response (SSE / NDJSON / raw) into discrete messages and applies
/// the node's <see cref="StreamingNodeOptions"/> to decide when to stop and what to forward
/// downstream as <c>nodes.{id}.response.body</c>.
/// </summary>
internal static class StreamProcessor
{
    public sealed record StreamResult(JsonNode? Body, int MessageCount, bool MatchedUntil, TimeSpan Elapsed);

    public static async Task<StreamResult> ConsumeAsync(
        Stream networkStream,
        string? contentType,
        StreamingNodeOptions options,
        IRuleEvaluator evaluator,
        CancellationToken cancellationToken)
    {
        var parser = ResolveParser(options.Parser, contentType);
        var sw = Stopwatch.StartNew();
        var messages = new List<JsonNode?>();
        var matchedUntil = false;

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        if (options.Timeout is { } t && t > TimeSpan.Zero)
        {
            timeoutCts.CancelAfter(t);
        }

        try
        {
            await foreach (var message in ReadMessagesAsync(networkStream, parser, timeoutCts.Token))
            {
                messages.Add(message);

                if (options.Mode == StreamingMode.First)
                {
                    break;
                }
                if (options.Mode == StreamingMode.Until && options.Until is not null)
                {
                    if (EvaluateUntil(options.Until, message, messages.Count - 1, sw.Elapsed, evaluator))
                    {
                        matchedUntil = true;
                        break;
                    }
                }
                if (options.MaxMessages is { } max && messages.Count >= max)
                {
                    break;
                }
            }
        }
        catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
        {
            // Hit the per-stream timeout; treat as graceful stop with what we collected.
        }

        sw.Stop();

        JsonNode? body = options.Mode switch
        {
            StreamingMode.First or StreamingMode.Until => messages.Count > 0 ? messages[^1]?.DeepClone() : null,
            _ => MessagesToArray(messages)
        };

        return new StreamResult(body, messages.Count, matchedUntil, sw.Elapsed);
    }

    private static JsonArray MessagesToArray(IEnumerable<JsonNode?> messages)
    {
        var arr = new JsonArray();
        foreach (var m in messages) arr.Add(m?.DeepClone());
        return arr;
    }

    private static StreamParser ResolveParser(StreamParser declared, string? contentType)
    {
        if (declared != StreamParser.Auto) return declared;
        if (string.IsNullOrEmpty(contentType)) return StreamParser.Raw;
        var ct = contentType.Split(';')[0].Trim().ToLowerInvariant();
        return ct switch
        {
            "text/event-stream" => StreamParser.Sse,
            "application/x-ndjson" or "application/jsonl"
                or "application/x-jsonlines" or "application/ndjson" => StreamParser.Ndjson,
            _ => StreamParser.Raw
        };
    }

    private static async IAsyncEnumerable<JsonNode?> ReadMessagesAsync(
        Stream stream,
        StreamParser parser,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken)
    {
        using var reader = new StreamReader(stream, Encoding.UTF8, leaveOpen: true);

        switch (parser)
        {
            case StreamParser.Sse:
                await foreach (var msg in ReadSseAsync(reader, cancellationToken)) yield return msg;
                break;
            case StreamParser.Ndjson:
                await foreach (var msg in ReadNdjsonAsync(reader, cancellationToken)) yield return msg;
                break;
            default:
                await foreach (var msg in ReadRawChunksAsync(reader, cancellationToken)) yield return msg;
                break;
        }
    }

    private static async IAsyncEnumerable<JsonNode?> ReadSseAsync(
        StreamReader reader,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken)
    {
        var dataBuilder = new StringBuilder();
        string? eventType = null;
        string? line;
        while ((line = await reader.ReadLineAsync(cancellationToken).ConfigureAwait(false)) is not null)
        {
            if (line.Length == 0)
            {
                if (dataBuilder.Length > 0)
                {
                    yield return BuildSseMessage(eventType, dataBuilder.ToString());
                    dataBuilder.Clear();
                    eventType = null;
                }
                continue;
            }

            if (line.StartsWith(":", StringComparison.Ordinal)) continue; // comment

            var colon = line.IndexOf(':');
            string field, value;
            if (colon < 0) { field = line; value = string.Empty; }
            else
            {
                field = line[..colon];
                value = colon + 1 < line.Length && line[colon + 1] == ' '
                    ? line[(colon + 2)..]
                    : line[(colon + 1)..];
            }

            switch (field)
            {
                case "data":
                    if (dataBuilder.Length > 0) dataBuilder.Append('\n');
                    dataBuilder.Append(value);
                    break;
                case "event":
                    eventType = value;
                    break;
                // id, retry: ignored for now.
            }
        }

        if (dataBuilder.Length > 0)
        {
            yield return BuildSseMessage(eventType, dataBuilder.ToString());
        }
    }

    private static JsonNode? BuildSseMessage(string? eventType, string data)
    {
        JsonNode? dataNode = null;
        try { dataNode = JsonNode.Parse(data); }
        catch (JsonException) { dataNode = JsonValue.Create(data); }

        var obj = new JsonObject { ["data"] = dataNode };
        if (!string.IsNullOrEmpty(eventType)) obj["event"] = eventType;
        return obj;
    }

    private static async IAsyncEnumerable<JsonNode?> ReadNdjsonAsync(
        StreamReader reader,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken)
    {
        string? line;
        while ((line = await reader.ReadLineAsync(cancellationToken).ConfigureAwait(false)) is not null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            JsonNode? node;
            try { node = JsonNode.Parse(line); }
            catch (JsonException) { node = JsonValue.Create(line); }
            yield return node;
        }
    }

    private static async IAsyncEnumerable<JsonNode?> ReadRawChunksAsync(
        StreamReader reader,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken)
    {
        var buffer = new char[4096];
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var read = await reader.ReadAsync(buffer.AsMemory(), cancellationToken).ConfigureAwait(false);
            if (read == 0) yield break;
            yield return JsonValue.Create(new string(buffer, 0, read));
        }
    }

    private static bool EvaluateUntil(JsonNode rule, JsonNode? message, int index, TimeSpan elapsed, IRuleEvaluator evaluator)
    {
        // Until predicates run against a flat per-message context: the JSONLogic root is
        // { message, index, elapsed }, so authors can write { "var": "message.data.status" }.
        // Bypass IRuleEvaluator's RunContext shape — it would force an "input." / "env." prefix.
        var data = new JsonObject
        {
            ["message"] = message?.DeepClone(),
            ["index"] = index,
            ["elapsed"] = elapsed.ToString()
        };
        var result = JsonLogic.Apply(rule.DeepClone(), data);
        return result switch
        {
            null => false,
            JsonValue v when v.TryGetValue<bool>(out var b) => b,
            JsonValue v when v.TryGetValue<string>(out var s) => !string.IsNullOrEmpty(s),
            JsonValue v when v.TryGetValue<double>(out var d) => d != 0,
            JsonArray a => a.Count > 0,
            JsonObject o => o.Count > 0,
            _ => true
        };
    }
}
