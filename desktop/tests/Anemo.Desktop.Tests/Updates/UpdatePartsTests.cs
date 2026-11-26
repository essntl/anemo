using System.Net;
using System.Text.Json.Nodes;
using Anemo.Desktop.Core.Updates;
using static Anemo.Desktop.Tests.Updates.UpdateBytes;

namespace Anemo.Desktop.Tests.Updates;

/// <summary>The pure parts: versions, picking the release, the checksum file, the signature, GitHub's addresses.</summary>
public sealed class UpdatePartsTests
{
    private const string Exe = "Anemo-Desktop-win-x64.exe";
    private const string Sums = "SHA256SUMS-desktop.txt";
    private static readonly AppVersion Current = new(1, 8, 0);

    [Theory]
    [InlineData("1.8.0", 1, 8, 0)]
    [InlineData("0.0.1", 0, 0, 1)]
    [InlineData("10.20.300", 10, 20, 300)]
    public void A_stable_version_parses(string text, int major, int minor, int patch) =>
        Assert.Equal(new AppVersion(major, minor, patch), AppVersion.Parse(text));

    [Theory]
    [InlineData("1.8")]
    [InlineData("1.8.0.0")]
    [InlineData("1.9.0-beta.1")]
    [InlineData("v1.8.0")]
    [InlineData("01.8.0")]
    [InlineData(" 1.8.0")]
    [InlineData("1.8.0\n")]
    [InlineData("1.8.x")]
    [InlineData("99999999999.0.0")]
    [InlineData("")]
    [InlineData(null)]
    public void Anything_else_does_not(string? text) => Assert.Null(AppVersion.Parse(text));

    [Fact]
    public void Versions_compare_by_number_not_by_text()
    {
        Assert.True(AppVersion.Parse("1.10.0") > AppVersion.Parse("1.9.0"));
        Assert.True(AppVersion.Parse("2.0.0") > AppVersion.Parse("1.99.99"));
        Assert.True(AppVersion.Parse("1.8.1") > AppVersion.Parse("1.8.0"));
        Assert.False(AppVersion.Parse("1.8.0") > AppVersion.Parse("1.8.0"));
        Assert.Equal("desktop-v1.8.0", Current.Tag);
    }

    [Theory]
    [InlineData("desktop-v1.9.0", "1.9.0")]
    [InlineData("voice-v1.9.0", null)]
    [InlineData("v1.9.0", null)]
    [InlineData("desktop-v1.9.0-rc.1", null)]
    [InlineData("Desktop-v1.9.0", null)]
    public void Only_desktop_tags_carry_a_version(string tag, string? version) =>
        Assert.Equal(AppVersion.Parse(version), AppVersion.FromTag(tag));

    [Fact]
    public void The_newest_stable_desktop_release_with_this_computers_files_is_picked()
    {
        var feed = new FakeReleaseFeed();
        feed.Add("desktop-v1.9.0", files: [(Exe, Text("a")), (Sums, Text("s"))]);
        feed.Add("desktop-v2.1.0", draft: true, files: [(Exe, Text("a")), (Sums, Text("s"))]);
        feed.Add("desktop-v2.0.0", prerelease: true, files: [(Exe, Text("a")), (Sums, Text("s"))]);
        feed.Add("voice-v9.0.0", files: [(Exe, Text("a")), (Sums, Text("s"))]);
        feed.Add("v9.0.0", files: [(Exe, Text("a")), (Sums, Text("s"))]);
        feed.Add("desktop-v1.10.0", files: [(Exe, Text("a")), (Sums, Text("s")), (Sums + ".sig", Text("g"))]);
        feed.Add("desktop-v1.11.0", files: [("Anemo-Desktop-win-arm64.exe", Text("a")), (Sums, Text("s"))]); // no x64 file
        feed.Add("desktop-v1.12.0", files: [(Exe, Text("a"))]); // no checksums

        var picked = ReleaseSelection.Pick(feed.Releases.ToJsonString(), Current, Exe, Sums);

        Assert.Equal(new UpdateCandidate(new AppVersion(1, 10, 0), "desktop-v1.10.0", Exe, Sums, true), picked);
    }

    [Fact]
    public void Nothing_newer_than_the_running_version_is_nothing()
    {
        var feed = new FakeReleaseFeed();
        feed.Add("desktop-v1.8.0", files: [(Exe, Text("a")), (Sums, Text("s"))]);
        feed.Add("desktop-v1.7.0", files: [(Exe, Text("a")), (Sums, Text("s"))]);

        Assert.Null(ReleaseSelection.Pick(feed.Releases.ToJsonString(), Current, Exe, Sums));
        Assert.Null(ReleaseSelection.Pick("[]", Current, Exe, Sums));
    }

    [Theory]
    [InlineData("{\"message\":\"Not Found\"}")]
    [InlineData("<html>")]
    public void An_answer_that_is_not_a_list_is_refused(string body) =>
        Assert.Throws<UpdateRefusedException>(() => ReleaseSelection.Pick(body, Current, Exe, Sums));

    [Fact]
    public void Odd_release_entries_are_skipped()
    {
        var json = new JsonArray
        {
            "text",
            new JsonObject { ["tag_name"] = 5 },
            new JsonObject { ["tag_name"] = "desktop-v1.9.0", ["draft"] = "yes", ["assets"] = new JsonArray { new JsonObject { ["name"] = Exe }, new JsonObject { ["name"] = Sums } } },
            new JsonObject { ["tag_name"] = "desktop-v1.9.1", ["assets"] = "none" },
        }.ToJsonString();

        Assert.Null(ReleaseSelection.Pick(json, Current, Exe, Sums));
    }

    [Fact]
    public void The_checksum_file_is_read_in_both_sha256sum_formats()
    {
        var a = new string('A', 64);
        var b = new string('b', 64);
        var text = $"{a} *Anemo-Desktop-win-arm64.exe\r\n{b}  {Exe}\n\nnot a line\n{new string('c', 63)}  short.exe\n";

        var hashes = Checksums.Parse(text);

        Assert.Equal(2, hashes.Count);
        Assert.Equal(new string('a', 64), hashes["Anemo-Desktop-win-arm64.exe"]);
        Assert.Equal(b, Checksums.For(Text(text), Exe));
    }

    [Fact]
    public void The_real_release_files_parse()
    {
        // As desktop-v1.6.1 has them: sha256sum on the Windows runner (binary mode) and shasum on the Mac.
        var windows = "4f1f09b9ba244aca987cf54e24695dc3190fc766b63392d64009db5147dc717e *Anemo-Desktop-win-arm64.exe\n"
            + "e223e9bef21551266e128bd628e18c1e26e5bb6e665b1f904392efc9ffcf53b0 *Anemo-Desktop-win-x64.exe\n";
        var mac = "d6abece065a00c552776d22acea1e995d8503a9b4838e79c688e4298686fe81a  Anemo-Desktop-macos-arm64.zip\n";

        Assert.Equal("e223e9bef21551266e128bd628e18c1e26e5bb6e665b1f904392efc9ffcf53b0", Checksums.For(Text(windows), Exe));
        Assert.Equal("d6abece065a00c552776d22acea1e995d8503a9b4838e79c688e4298686fe81a", Checksums.For(Text(mac), "Anemo-Desktop-macos-arm64.zip"));
    }

    [Fact]
    public void A_missing_or_ambiguous_entry_is_refused()
    {
        Assert.Throws<UpdateRefusedException>(() => Checksums.For(Text($"{new string('a', 64)}  other.exe\n"), Exe));
        Assert.Throws<UpdateRefusedException>(() => Checksums.Parse($"{new string('a', 64)}  {Exe}\n{new string('b', 64)}  {Exe}\n"));
        Assert.Single(Checksums.Parse($"{new string('a', 64)}  {Exe}\n{new string('A', 64)} *{Exe}\n")); // the same twice is fine
    }

    [Fact]
    public void A_hash_matches_only_its_own_bytes()
    {
        var bytes = Text("the exe");
        var hash = Sha256(bytes);

        Assert.True(Checksums.Same(hash, System.Security.Cryptography.SHA256.HashData(bytes)));
        Assert.True(Checksums.Same(hash.ToUpperInvariant(), System.Security.Cryptography.SHA256.HashData(bytes)));
        Assert.False(Checksums.Same(hash, System.Security.Cryptography.SHA256.HashData(Text("the exe!"))));
    }

    [Fact]
    public void The_signature_covers_the_checksum_file_and_the_tag()
    {
        using var key = new TestSigningKey();
        var sums = Text($"{new string('a', 64)}  {Exe}\n");
        var signature = key.Sign("desktop-v1.9.0", sums);

        Assert.True(UpdateSignature.IsKey(key.PublicKey));
        Assert.True(UpdateSignature.Verify(key.PublicKey, "desktop-v1.9.0", sums, signature));
        Assert.False(UpdateSignature.Verify(key.PublicKey, "desktop-v1.9.1", sums, signature)); // another release's file
        Assert.False(UpdateSignature.Verify(key.PublicKey, "desktop-v1.9.0", Text($"{new string('b', 64)}  {Exe}\n"), signature));
        Assert.False(UpdateSignature.Verify(key.PublicKey, "desktop-v1.9.0", sums, Text("garbage")));

        using var other = new TestSigningKey();
        Assert.False(UpdateSignature.Verify(other.PublicKey, "desktop-v1.9.0", sums, signature));
    }

    [Theory]
    [InlineData("not base64!")]
    [InlineData("AAAA")]
    public void A_damaged_key_is_no_key(string key)
    {
        Assert.False(UpdateSignature.IsKey(key));
        Assert.False(UpdateSignature.Verify(key, "desktop-v1.9.0", Text("x"), Text("y")));
    }

    [Fact]
    public void The_signed_message_is_what_release_yml_pipes_into_openssl()
    {
        // printf 'anemo-desktop-update %s\n' "$tag"; cat SHA256SUMS-desktop.txt
        Assert.Equal(Text("anemo-desktop-update desktop-v1.9.0\nsums"), UpdateSignature.Message("desktop-v1.9.0", Text("sums")));
    }

    [Fact]
    public void A_build_without_a_key_checks_checksums_only_and_uses_the_default_repository()
    {
        // The tests are built like a development build: Directory.Build.props's default repository, no key.
        var options = UpdateOptions.FromBuild(typeof(UpdatePartsTests).Assembly);

        Assert.Equal("essntl/anemo", options.Repository);
        Assert.Null(options.PublicKey);
    }

    [Theory]
    [InlineData("essntl/anemo", true)]
    [InlineData("some-one/a.repo_name", true)]
    [InlineData("anemo", false)]
    [InlineData("a/b/c", false)]
    [InlineData("../x", false)]
    [InlineData("owner/name?x=1", false)]
    public void The_repository_is_owner_slash_name(string repository, bool ok) =>
        Assert.Equal(ok, GitHubReleaseFeed.IsRepository(repository));

    [Fact]
    public async Task GitHub_is_asked_with_the_etag_and_a_304_says_not_modified()
    {
        var handler = new RecordingHandler(request => request.Headers.IfNoneMatch.Count > 0
            ? new HttpResponseMessage(HttpStatusCode.NotModified)
            : Ok("[]", etag: "\"abc\""));
        using var feed = new GitHubReleaseFeed("essntl/anemo", "1.8.0", handler);

        var first = await feed.GetReleasesAsync(null, CancellationToken.None);
        var second = await feed.GetReleasesAsync(first.ETag, CancellationToken.None);

        Assert.Equal(new ReleasesResponse(false, "[]", "\"abc\""), first);
        Assert.True(second.NotModified);
        var request = handler.Requests[0];
        Assert.Equal("https://api.github.com/repos/essntl/anemo/releases?per_page=50", request.Uri);
        Assert.Equal("Anemo-Desktop/1.8.0", request.UserAgent);
        Assert.Null(request.Authorization);
        Assert.Equal("\"abc\"", handler.Requests[1].IfNoneMatch);
    }

    [Fact]
    public async Task Files_come_from_the_address_built_from_the_tag_and_name()
    {
        var handler = new RecordingHandler(_ => Ok("data"));
        using var feed = new GitHubReleaseFeed("essntl/anemo", "1.8.0", handler);

        var bytes = await feed.GetSmallAssetAsync("desktop-v1.9.0", "SHA256SUMS-desktop.txt", 100, CancellationToken.None);
        using var target = new MemoryStream();
        await feed.DownloadAssetAsync("desktop-v1.9.0", "Anemo Desktop?.exe", target, 100, CancellationToken.None);

        Assert.Equal(Text("data"), bytes);
        Assert.Equal(Text("data"), target.ToArray());
        Assert.Equal("https://github.com/essntl/anemo/releases/download/desktop-v1.9.0/SHA256SUMS-desktop.txt", handler.Requests[0].Uri);
        Assert.Equal("https://github.com/essntl/anemo/releases/download/desktop-v1.9.0/Anemo%20Desktop%3F.exe", handler.Requests[1].Uri);
    }

    [Fact]
    public async Task Too_big_files_and_GitHub_errors_are_sentences()
    {
        using var big = new GitHubReleaseFeed("essntl/anemo", "1.8.0", new RecordingHandler(_ => Ok(new string('x', 200))));
        using var target = new MemoryStream();
        await Assert.ThrowsAsync<ReleaseFeedException>(() => big.DownloadAssetAsync("t", "a", target, 100, CancellationToken.None));
        await Assert.ThrowsAsync<ReleaseFeedException>(() => big.GetSmallAssetAsync("t", "a", 100, CancellationToken.None));

        using var limited = new GitHubReleaseFeed("essntl/anemo", "1.8.0", new RecordingHandler(_ => new HttpResponseMessage(HttpStatusCode.Forbidden)));
        var e = await Assert.ThrowsAsync<ReleaseFeedException>(() => limited.GetReleasesAsync(null, CancellationToken.None));
        Assert.Contains("limit", e.Message);

        using var gone = new GitHubReleaseFeed("essntl/anemo", "1.8.0", new RecordingHandler(_ => new HttpResponseMessage(HttpStatusCode.NotFound)));
        await Assert.ThrowsAsync<ReleaseFeedException>(() => gone.GetSmallAssetAsync("t", "a", 100, CancellationToken.None));

        using var down = new GitHubReleaseFeed("essntl/anemo", "1.8.0", new RecordingHandler(_ => throw new HttpRequestException("no route")));
        e = await Assert.ThrowsAsync<ReleaseFeedException>(() => down.GetReleasesAsync(null, CancellationToken.None));
        Assert.Equal("GitHub couldn't be reached.", e.Message);
    }

    private static HttpResponseMessage Ok(string body, string? etag = null)
    {
        var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body) };
        if (etag is not null)
        {
            response.Headers.ETag = System.Net.Http.Headers.EntityTagHeaderValue.Parse(etag);
        }

        return response;
    }

    private sealed record Seen(string Uri, string? UserAgent, string? IfNoneMatch, string? Authorization);

    private sealed class RecordingHandler(Func<HttpRequestMessage, HttpResponseMessage> answer) : HttpMessageHandler
    {
        public List<Seen> Requests { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add(new Seen(
                request.RequestUri!.AbsoluteUri,
                request.Headers.UserAgent.ToString(),
                request.Headers.IfNoneMatch.FirstOrDefault()?.ToString(),
                request.Headers.Authorization?.ToString()));
            var response = answer(request);
            response.RequestMessage = request;
            return Task.FromResult(response);
        }
    }
}
