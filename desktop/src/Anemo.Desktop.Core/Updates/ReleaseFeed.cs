using System.Net;
using System.Net.Http.Headers;
using System.Text.RegularExpressions;

namespace Anemo.Desktop.Core.Updates;

/// <summary>The answer to a list request: the body and its ETag, or "not modified" (the cached list is still right).</summary>
public sealed record ReleasesResponse(bool NotModified, string? Body, string? ETag);

/// <summary>
/// Where releases come from. The only implementation that talks to the network is
/// <see cref="GitHubReleaseFeed"/>; the tests give the updater a fake.
/// </summary>
public interface IReleaseFeed
{
    /// <summary>The list of releases; <paramref name="etag"/> from the last answer makes GitHub answer 304 when nothing changed.</summary>
    Task<ReleasesResponse> GetReleasesAsync(string? etag, CancellationToken ct);

    /// <summary>A small file of a release (the checksums, the signature), at most <paramref name="maxBytes"/>.</summary>
    Task<byte[]> GetSmallAssetAsync(string tag, string asset, int maxBytes, CancellationToken ct);

    /// <summary>Streams a release file into <paramref name="target"/>; more than <paramref name="maxBytes"/> fails.</summary>
    Task DownloadAssetAsync(string tag, string asset, Stream target, long maxBytes, CancellationToken ct);
}

/// <summary>Something went wrong talking to GitHub; the message is a sentence for the user.</summary>
public sealed class ReleaseFeedException(string message, Exception? inner = null) : Exception(message, inner);

/// <summary>
/// GitHub Releases, unauthenticated, over HTTPS only: the list from
/// <c>https://api.github.com/repos/{repo}/releases</c> (with <c>If-None-Match</c>: a 304 doesn't
/// count against the 60 requests an hour GitHub allows an address) and the files from
/// <c>https://github.com/{repo}/releases/download/{tag}/{name}</c>. The file addresses are built
/// here from the repository, the tag and the name, never taken from the API's answer.
/// What GitHub sees: this computer's address and the User-Agent <c>Anemo-Desktop/&lt;version&gt;</c>.
/// </summary>
public sealed partial class GitHubReleaseFeed : IReleaseFeed, IDisposable
{
    /// <summary>The releases are newest first; 50 covers months of desktop, voice and server releases.</summary>
    private const int PerPage = 50;

    private static readonly TimeSpan SmallTimeout = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan DownloadTimeout = TimeSpan.FromMinutes(30);

    private readonly HttpClient _http;
    private readonly string _repository;

    /// <param name="repository"><c>owner/name</c>.</param>
    /// <param name="handler">For tests only (no network); null uses the system's proxy settings as usual.</param>
    public GitHubReleaseFeed(string repository, string version, HttpMessageHandler? handler = null)
    {
        if (!IsRepository(repository))
        {
            throw new ArgumentException("not an owner/name repository", nameof(repository));
        }

        _repository = repository;
        // Per-request timeouts below; the client's own would cut a slow 80 MB download.
        _http = handler is null ? new HttpClient() : new HttpClient(handler, disposeHandler: true);
        _http.Timeout = System.Threading.Timeout.InfiniteTimeSpan;
        _http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("Anemo-Desktop", version));
    }

    public static bool IsRepository(string text) => Repository().IsMatch(text);

    public Uri ReleasesUri => new($"https://api.github.com/repos/{_repository}/releases?per_page={PerPage}");

    public Uri AssetUri(string tag, string asset) =>
        new($"https://github.com/{_repository}/releases/download/{Uri.EscapeDataString(tag)}/{Uri.EscapeDataString(asset)}");

    public async Task<ReleasesResponse> GetReleasesAsync(string? etag, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, ReleasesUri);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
        request.Headers.Add("X-GitHub-Api-Version", "2022-11-28");
        if (etag is not null && EntityTagHeaderValue.TryParse(etag, out var tag))
        {
            request.Headers.IfNoneMatch.Add(tag);
        }

        using var timeout = WithTimeout(ct, SmallTimeout);
        using var response = await Send(request, timeout.Token);
        if (response.StatusCode == HttpStatusCode.NotModified)
        {
            return new ReleasesResponse(true, null, etag);
        }

        Check(response);
        var body = await ReadLimited(response, 4 * 1024 * 1024, timeout.Token);
        return new ReleasesResponse(false, System.Text.Encoding.UTF8.GetString(body), response.Headers.ETag?.ToString());
    }

    public async Task<byte[]> GetSmallAssetAsync(string tag, string asset, int maxBytes, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, AssetUri(tag, asset));
        using var timeout = WithTimeout(ct, SmallTimeout);
        using var response = await Send(request, timeout.Token);
        Check(response);
        return await ReadLimited(response, maxBytes, timeout.Token);
    }

    public async Task DownloadAssetAsync(string tag, string asset, Stream target, long maxBytes, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, AssetUri(tag, asset));
        using var timeout = WithTimeout(ct, DownloadTimeout);
        using var response = await Send(request, timeout.Token);
        Check(response);
        if (response.Content.Headers.ContentLength > maxBytes)
        {
            throw new ReleaseFeedException($"{asset} is bigger than an update can be.");
        }

        await using var body = await response.Content.ReadAsStreamAsync(timeout.Token);
        var buffer = new byte[81920];
        long total = 0;
        int read;
        while ((read = await body.ReadAsync(buffer, timeout.Token)) > 0)
        {
            total += read;
            if (total > maxBytes)
            {
                throw new ReleaseFeedException($"{asset} is bigger than an update can be.");
            }

            await target.WriteAsync(buffer.AsMemory(0, read), timeout.Token);
        }
    }

    public void Dispose() => _http.Dispose();

    private static CancellationTokenSource WithTimeout(CancellationToken ct, TimeSpan after)
    {
        var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(after);
        return cts;
    }

    private async Task<HttpResponseMessage> Send(HttpRequestMessage request, CancellationToken ct)
    {
        try
        {
            var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
            // Redirects (github.com sends the files from its storage host) are followed by
            // HttpClient, which never follows one from https to http; this makes sure of it.
            if (response.RequestMessage?.RequestUri is { } final && final.Scheme != Uri.UriSchemeHttps)
            {
                response.Dispose();
                throw new ReleaseFeedException("GitHub redirected the update to an address without HTTPS.");
            }

            return response;
        }
        catch (HttpRequestException e)
        {
            throw new ReleaseFeedException("GitHub couldn't be reached.", e);
        }

        // A timeout is an OperationCanceledException; the updater tells it from its own stop.
    }

    private static void Check(HttpResponseMessage response)
    {
        if (response.IsSuccessStatusCode)
        {
            return;
        }

        throw response.StatusCode switch
        {
            HttpStatusCode.Forbidden or HttpStatusCode.TooManyRequests =>
                new ReleaseFeedException("GitHub's limit for update checks from this address was reached; Anemo Desktop tries again later."),
            HttpStatusCode.NotFound => new ReleaseFeedException("The release or its file isn't on GitHub (any more)."),
            _ => new ReleaseFeedException($"GitHub answered {(int)response.StatusCode}."),
        };
    }

    private static async Task<byte[]> ReadLimited(HttpResponseMessage response, int maxBytes, CancellationToken ct)
    {
        await using var body = await response.Content.ReadAsStreamAsync(ct);
        using var memory = new MemoryStream();
        var buffer = new byte[16384];
        int read;
        while ((read = await body.ReadAsync(buffer, ct)) > 0)
        {
            if (memory.Length + read > maxBytes)
            {
                throw new ReleaseFeedException("A file of the release is bigger than it can be.");
            }

            memory.Write(buffer, 0, read);
        }

        return memory.ToArray();
    }

    [GeneratedRegex(@"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$", RegexOptions.CultureInvariant)]
    private static partial Regex Repository();
}

/// <summary>For a client that doesn't update (no host platform): never asked, as the updater is unavailable.</summary>
public sealed class NoReleaseFeed : IReleaseFeed
{
    public static readonly NoReleaseFeed Instance = new();

    public Task<ReleasesResponse> GetReleasesAsync(string? etag, CancellationToken ct) => throw new ReleaseFeedException("no updates here");

    public Task<byte[]> GetSmallAssetAsync(string tag, string asset, int maxBytes, CancellationToken ct) => throw new ReleaseFeedException("no updates here");

    public Task DownloadAssetAsync(string tag, string asset, Stream target, long maxBytes, CancellationToken ct) => throw new ReleaseFeedException("no updates here");
}
