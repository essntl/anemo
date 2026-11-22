namespace Anemo.Desktop.Core.Connection;

/// <summary>
/// The address the web app uses, and the URLs the client builds from it. The token is
/// never part of a URL: it goes in <c>hello</c> and in the Authorization header.
/// </summary>
public sealed class AnemoAddress
{
    private AnemoAddress(Uri baseUri) => BaseUri = baseUri;

    /// <summary>The web app, without a trailing slash, e.g. <c>https://anemo.example.com</c>.</summary>
    public Uri BaseUri { get; }

    /// <summary><c>wss://…/api/devices/ws</c> (<c>ws://</c> only for a local test server).</summary>
    public Uri WebSocketUri => Build(BaseUri.Scheme == Uri.UriSchemeHttps ? "wss" : "ws", "/api/devices/ws");

    public Uri SharedScreenUri => Build(BaseUri.Scheme, "/api/devices/shared-screen");

    /// <summary>
    /// Parses what the user typed. HTTPS is required (the token travels on it); plain
    /// HTTP only for <c>localhost</c> and loopback addresses. Null when it isn't valid.
    /// </summary>
    public static AnemoAddress? Parse(string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return null;
        }

        var trimmed = text.Trim();
        if (!trimmed.Contains("://", StringComparison.Ordinal))
        {
            trimmed = "https://" + trimmed;
        }

        if (!Uri.TryCreate(trimmed, UriKind.Absolute, out var uri)
            || !string.IsNullOrEmpty(uri.Query)
            || !string.IsNullOrEmpty(uri.Fragment)
            || !string.IsNullOrEmpty(uri.UserInfo))
        {
            return null;
        }

        var secure = uri.Scheme == Uri.UriSchemeHttps;
        var local = uri.Scheme == Uri.UriSchemeHttp && uri.IsLoopback;
        if (!secure && !local)
        {
            return null;
        }

        var path = uri.AbsolutePath.TrimEnd('/');
        return new AnemoAddress(new UriBuilder(uri.Scheme, uri.Host, uri.Port, path).Uri);
    }

    public override string ToString() => BaseUri.ToString().TrimEnd('/');

    private Uri Build(string scheme, string path)
    {
        var builder = new UriBuilder(BaseUri)
        {
            Scheme = scheme,
            Path = BaseUri.AbsolutePath.TrimEnd('/') + path,
        };
        return builder.Uri;
    }
}
