using APICover.Abstractions.Services;

namespace APICover.Hosting;

/// <summary>
/// DelegatingHandler that asks every registered <see cref="IAPICoverAuthProvider"/> for a header
/// value and attaches it to the outbound request. Skips providers that return <c>null</c>.
/// Existing request headers win — providers do not overwrite explicit per-node headers.
/// </summary>
internal sealed class AuthHeaderDelegatingHandler : DelegatingHandler
{
    private readonly IEnumerable<IAPICoverAuthProvider> _providers;

    public AuthHeaderDelegatingHandler(IEnumerable<IAPICoverAuthProvider> providers)
    {
        _providers = providers;
    }

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        foreach (var provider in _providers)
        {
            if (request.Headers.Contains(provider.HeaderName)) continue;

            var value = await provider.GetHeaderValueAsync(request, cancellationToken).ConfigureAwait(false);
            if (string.IsNullOrEmpty(value)) continue;

            request.Headers.TryAddWithoutValidation(provider.HeaderName, value);
        }

        return await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
    }
}
