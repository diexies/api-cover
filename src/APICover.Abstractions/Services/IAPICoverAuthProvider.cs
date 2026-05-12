namespace APICover.Abstractions.Services;

/// <summary>
/// Resolves an Authorization header value for outbound engine requests against the host.
/// Hosts with auth-protected endpoints (e.g. JWT bearer, API key) register an implementation so
/// the engine's HttpClient can attach a credential per request.
///
/// Multiple providers can be registered; the engine concatenates their non-null values into the
/// outbound headers. Return <c>null</c> to skip the request.
/// </summary>
public interface IAPICoverAuthProvider
{
    /// <summary>Header name to set (e.g. <c>Authorization</c>, <c>X-Api-Key</c>).</summary>
    string HeaderName { get; }

    /// <summary>
    /// Produce the header value for an outbound request. Receives the request URI + method so the
    /// provider can decide whether to attach a credential or skip (e.g. health endpoints).
    /// Return <c>null</c> to omit the header for this request.
    /// </summary>
    ValueTask<string?> GetHeaderValueAsync(HttpRequestMessage request, CancellationToken ct);
}
