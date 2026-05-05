using System.Text;
using System.Text.Json.Nodes;
using APICover.Abstractions.Models;
using APICover.Engine;

namespace APICover.Tests.Engine;

public class StreamProcessorTests
{
    private readonly JsonLogicRuleEvaluator _evaluator = new();

    [Fact]
    public async Task Sse_collect_mode_returns_array_of_messages()
    {
        var sse = "event: progress\ndata: {\"step\":1}\n\nevent: progress\ndata: {\"step\":2}\n\n";
        var result = await Consume(sse, "text/event-stream", new StreamingNodeOptions
        {
            Mode = StreamingMode.Collect,
            Parser = StreamParser.Sse
        });

        var arr = Assert.IsType<JsonArray>(result.Body);
        Assert.Equal(2, arr.Count);
        Assert.Equal(1, arr[0]!["data"]!["step"]!.GetValue<int>());
        Assert.Equal("progress", arr[0]!["event"]!.GetValue<string>());
    }

    [Fact]
    public async Task Sse_first_mode_stops_at_first_message()
    {
        var sse = "data: {\"i\":1}\n\ndata: {\"i\":2}\n\n";
        var result = await Consume(sse, "text/event-stream", new StreamingNodeOptions
        {
            Mode = StreamingMode.First,
            Parser = StreamParser.Sse
        });

        Assert.Equal(1, result.MessageCount);
        Assert.Equal(1, result.Body!["data"]!["i"]!.GetValue<int>());
    }

    [Fact]
    public async Task Sse_until_mode_stops_when_predicate_matches()
    {
        var sse = "data: {\"status\":\"running\"}\n\ndata: {\"status\":\"completed\"}\n\ndata: {\"status\":\"after\"}\n\n";
        var until = JsonNode.Parse("""{"==":[{"var":"message.data.status"}, "completed"]}""");
        var result = await Consume(sse, "text/event-stream", new StreamingNodeOptions
        {
            Mode = StreamingMode.Until,
            Parser = StreamParser.Sse,
            Until = until
        });

        Assert.True(result.MatchedUntil);
        Assert.Equal(2, result.MessageCount);
        Assert.Equal("completed", result.Body!["data"]!["status"]!.GetValue<string>());
    }

    [Fact]
    public async Task Ndjson_collect_mode_parses_lines()
    {
        var ndjson = "{\"i\":1}\n{\"i\":2}\n{\"i\":3}\n";
        var result = await Consume(ndjson, "application/x-ndjson", new StreamingNodeOptions
        {
            Mode = StreamingMode.Collect
        });

        var arr = Assert.IsType<JsonArray>(result.Body);
        Assert.Equal(3, arr.Count);
        Assert.Equal(2, arr[1]!["i"]!.GetValue<int>());
    }

    [Fact]
    public async Task MaxMessages_caps_collected_count()
    {
        var ndjson = "{\"i\":1}\n{\"i\":2}\n{\"i\":3}\n{\"i\":4}\n";
        var result = await Consume(ndjson, "application/x-ndjson", new StreamingNodeOptions
        {
            Mode = StreamingMode.Collect,
            MaxMessages = 2
        });

        var arr = Assert.IsType<JsonArray>(result.Body);
        Assert.Equal(2, arr.Count);
    }

    [Fact]
    public async Task Auto_parser_picks_sse_for_event_stream_content_type()
    {
        var sse = "data: hello\n\n";
        var result = await Consume(sse, "text/event-stream", new StreamingNodeOptions
        {
            Mode = StreamingMode.First,
            Parser = StreamParser.Auto
        });
        Assert.Equal("hello", result.Body!["data"]!.GetValue<string>());
    }

    private async Task<StreamProcessor.StreamResult> Consume(
        string payload, string contentType, StreamingNodeOptions options)
    {
        using var stream = new MemoryStream(Encoding.UTF8.GetBytes(payload));
        return await StreamProcessor.ConsumeAsync(stream, contentType, options, _evaluator, CancellationToken.None);
    }
}
