using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Anemo.Desktop.Core.CodeJobs;

/// <summary>An open pull request as the git graph answers it (device-contracts.md §7.6).</summary>
public sealed record PullRequest(int Number, string Title, string HeadRef, string Url, bool Draft);

/// <summary>
/// The open pull requests of a GitHub repository, for the <c>pull_requests</c> of
/// <c>code_git_graph</c>: <c>gh pr list --repo owner/name --state open --limit 100 --json …</c>
/// (an argument list, 15 s). Anything that goes wrong (no gh, not signed in, a timeout, output
/// that doesn't read) is null, silently. An answer is kept 2 minutes per repository unless the
/// read fetches; a null too, so a gh that isn't signed in doesn't cost every read its timeout.
/// </summary>
public sealed class GitHubPullRequests
{
    public const int MaxPullRequests = 100;
    public const int MaxTitleChars = 300;

    /// <summary>gh's arguments for <paramref name="repo"/> (<c>owner/name</c>).</summary>
    public static IReadOnlyList<string> Arguments(string repo) =>
        ["pr", "list", "--repo", repo, "--state", "open", "--limit", "100", "--json", "number,title,headRefName,url,isDraft,state"];

    private readonly ICodeHost _host;
    private readonly TimeProvider _time;
    private readonly TimeSpan _timeout;
    private readonly TimeSpan _keep;
    private readonly ConcurrentDictionary<string, (DateTimeOffset At, IReadOnlyList<PullRequest>? List)> _kept = new(StringComparer.Ordinal);

    public GitHubPullRequests(ICodeHost host, TimeProvider time, TimeSpan timeout, TimeSpan keep)
    {
        _host = host;
        _time = time;
        _timeout = timeout;
        _keep = keep;
    }

    /// <param name="gh">gh's full path, or null when it isn't on the computer.</param>
    /// <param name="repo"><c>owner/name</c>, checked with <see cref="GitHubRepo.IsRepo"/>.</param>
    /// <param name="refresh">Ask gh even when an answer is kept (the read fetches).</param>
    public async Task<JsonArray?> ListAsync(string? gh, string repo, bool refresh, CancellationToken ct)
    {
        if (gh is null || !GitHubRepo.IsRepo(repo))
        {
            return null;
        }

        var key = repo.ToLowerInvariant();
        var now = _time.GetUtcNow();
        if (!refresh && _kept.TryGetValue(key, out var kept) && now - kept.At < _keep)
        {
            return Json(kept.List);
        }

        var list = await ReadAsync(gh, repo, ct);
        _kept[key] = (now, list);
        return Json(list);
    }

    /// <summary>
    /// The pull requests in gh's JSON: only open ones with a number, a title, a branch and an
    /// <c>https://github.com/</c> URL, at most <see cref="MaxPullRequests"/>, titles cut to
    /// <see cref="MaxTitleChars"/>. Null when it isn't a JSON list.
    /// </summary>
    public static IReadOnlyList<PullRequest>? Parse(string json)
    {
        try
        {
            if (JsonNode.Parse(json) is not JsonArray items)
            {
                return null;
            }

            var list = new List<PullRequest>();
            foreach (var item in items.OfType<JsonObject>())
            {
                if (Int(item, "number") is not { } number || number <= 0
                    || Str(item, "title") is not { } title
                    || Str(item, "headRefName") is not { Length: > 0 } head
                    || Str(item, "url") is not { } url
                    || !url.StartsWith("https://github.com/", StringComparison.Ordinal)
                    || Str(item, "state") != "OPEN")
                {
                    continue;
                }

                list.Add(new PullRequest(number, title.Length > MaxTitleChars ? title[..MaxTitleChars] : title, head, url, Flag(item, "isDraft")));
                if (list.Count == MaxPullRequests)
                {
                    break;
                }
            }

            return list;
        }
        catch (Exception e) when (e is JsonException or ArgumentException or InvalidOperationException or FormatException)
        {
            return null;
        }
    }

    private async Task<IReadOnlyList<PullRequest>?> ReadAsync(string gh, string repo, CancellationToken ct)
    {
        try
        {
            var result = await _host.RunAsync(
                new ToolRun(gh, Arguments(repo), Path.GetTempPath(), CodeJobControl.QuietEnvironment), _timeout, ct);
            return result.ExitCode == 0 ? Parse(result.Stdout) : null;
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            return null; // a timeout, or gh that wouldn't start
        }
    }

    private static JsonArray? Json(IReadOnlyList<PullRequest>? list) => list is null
        ? null
        : new JsonArray(list.Select(p => (JsonNode)new JsonObject
        {
            ["number"] = p.Number,
            ["title"] = p.Title,
            ["head_ref"] = p.HeadRef,
            ["url"] = p.Url,
            ["draft"] = p.Draft,
        }).ToArray());

    private static int? Int(JsonObject item, string key) =>
        item[key] is JsonValue v && v.TryGetValue<int>(out var n) ? n : null;

    private static string? Str(JsonObject item, string key) =>
        item[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    private static bool Flag(JsonObject item, string key) =>
        item[key] is JsonValue v && v.TryGetValue<bool>(out var b) && b;
}
