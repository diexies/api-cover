using System.Collections;
using APICover.Abstractions.Discovery;

namespace APICover.Discovery;

/// <summary>
/// Classifies a response payload as JSON / text / SSE / NDJSON / binary / stream so the
/// engine and UI know how to consume it. Detection precedence:
/// (1) declared content-type via <c>[Produces]</c> / <c>SupportedResponseTypes</c>,
/// (2) CLR return type (<c>IAsyncEnumerable&lt;T&gt;</c> → SSE, <c>Stream</c> → Stream).
/// </summary>
internal static class ResponseKindResolver
{
    public static ResponseKind Resolve(Type? returnType, IReadOnlyList<EndpointMediaType> media)
    {
        // (1) Content-type wins when explicit and unambiguous.
        var nonJsonKinds = media
            .Select(m => m.Kind)
            .Where(k => k is ResponseKind.Sse or ResponseKind.Ndjson or ResponseKind.Binary or ResponseKind.Text)
            .ToList();

        if (nonJsonKinds.Count > 0)
        {
            return nonJsonKinds[0];
        }

        // (2) CLR return type fallback.
        if (returnType is not null)
        {
            var unwrapped = UnwrapTaskAndActionResult(returnType);
            if (IsAsyncEnumerable(unwrapped)) return ResponseKind.Sse;
            if (IsStreamLike(unwrapped)) return ResponseKind.Stream;
        }

        // (3) Anything declared with application/json content-type.
        if (media.Any(m => m.Kind == ResponseKind.Json)) return ResponseKind.Json;

        return ResponseKind.Unknown;
    }

    public static ResponseKind FromContentType(string? contentType)
    {
        if (string.IsNullOrWhiteSpace(contentType)) return ResponseKind.Unknown;
        var ct = contentType.Split(';')[0].Trim().ToLowerInvariant();

        if (ct == "text/event-stream") return ResponseKind.Sse;
        if (ct is "application/x-ndjson" or "application/jsonl" or "application/x-jsonlines"
            or "application/ndjson") return ResponseKind.Ndjson;
        if (ct == "application/json" || ct == "text/json"
            || ct.EndsWith("+json", StringComparison.Ordinal)) return ResponseKind.Json;
        if (ct.StartsWith("text/", StringComparison.Ordinal)) return ResponseKind.Text;
        if (ct == "application/octet-stream"
            || ct.StartsWith("image/", StringComparison.Ordinal)
            || ct.StartsWith("audio/", StringComparison.Ordinal)
            || ct.StartsWith("video/", StringComparison.Ordinal)
            || ct == "application/pdf"
            || ct == "application/zip") return ResponseKind.Binary;
        return ResponseKind.Unknown;
    }

    private static Type UnwrapTaskAndActionResult(Type t)
    {
        if (t.IsGenericType)
        {
            var def = t.GetGenericTypeDefinition();
            if (def == typeof(Task<>) || def == typeof(ValueTask<>))
            {
                return UnwrapTaskAndActionResult(t.GetGenericArguments()[0]);
            }
            // Microsoft.AspNetCore.Mvc.ActionResult<T>
            if (def.FullName == "Microsoft.AspNetCore.Mvc.ActionResult`1")
            {
                return UnwrapTaskAndActionResult(t.GetGenericArguments()[0]);
            }
        }
        return t;
    }

    private static bool IsAsyncEnumerable(Type t)
    {
        if (t.IsGenericType && t.GetGenericTypeDefinition() == typeof(IAsyncEnumerable<>)) return true;
        return t.GetInterfaces().Any(i => i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IAsyncEnumerable<>));
    }

    private static bool IsStreamLike(Type t)
    {
        if (typeof(System.IO.Stream).IsAssignableFrom(t)) return true;
        if (t.FullName is "Microsoft.AspNetCore.Mvc.FileStreamResult"
            or "Microsoft.AspNetCore.Mvc.FileResult"
            or "Microsoft.AspNetCore.Mvc.PhysicalFileResult"
            or "Microsoft.AspNetCore.Mvc.VirtualFileResult") return true;
        return false;
    }
}
