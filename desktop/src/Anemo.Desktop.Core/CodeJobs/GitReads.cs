using System.Globalization;
using System.Text.Json.Nodes;
using Anemo.Desktop.Core.Commands;

namespace Anemo.Desktop.Core.CodeJobs;

/// <summary>
/// Read-only git for <c>code_git_graph</c> and <c>code_git_commit</c> (device-contracts.md
/// §7.5): a fixed set of git commands (rev-parse, symbolic-ref, for-each-ref, log, status,
/// remote, show, diff-tree), each with its arguments as a list (never through a shell), in a
/// project folder <see cref="CodeJobControl"/> has checked. Only metadata is answered: no
/// file contents, no diffs.
///
/// Every run turns off what a repository's own config could make git run or fetch
/// (fsmonitor, signature checks, lazy fetches of a partial clone), takes no optional locks
/// (a read never blocks a job's git), and runs with LC_ALL=C so the words git prints
/// (<c>ahead 2, behind 1</c>) are always English.
///
/// The same reads work on a blobless bare clone of the git cache (§7.6, <c>bare</c>): there is
/// no working tree, so <c>status</c> is null, and a commit's files come from
/// <c>--name-status</c> alone (line counts and rename detection would need the file contents,
/// which the cache doesn't have and, with GIT_NO_LAZY_FETCH, never downloads).
/// </summary>
public sealed class GitReads
{
    public const int MaxLimit = 1000;
    public const int DefaultLimit = 300;
    public const int MaxFiles = 1000;
    public const int MaxBodyChars = 10_000;
    public const int MaxRefs = 2000;

    /// <summary>In front of every git command: settings that keep a read a read.</summary>
    public static readonly IReadOnlyList<string> SafeOptions =
    [
        "-c", "core.quotepath=off",
        "-c", "core.fsmonitor=false",
        "-c", "log.showSignature=false",
        "-c", "color.ui=never",
        "--no-optional-locks",
    ];

    /// <summary>Set for every run, on top of <see cref="CodeJobControl.QuietEnvironment"/>.</summary>
    public static readonly IReadOnlyDictionary<string, string> Environment =
        new Dictionary<string, string>(CodeJobControl.QuietEnvironment)
        {
            ["GIT_OPTIONAL_LOCKS"] = "0",
            ["GIT_NO_LAZY_FETCH"] = "1",
            ["GIT_PAGER"] = "cat",
            ["LC_ALL"] = "C",
            ["LANGUAGE"] = "C",
        };

    private readonly ICodeHost _host;
    private readonly string _git;
    private readonly string _dir;
    private readonly TimeSpan _timeout;
    private readonly bool _bare;

    /// <param name="git">git's full path (never a .cmd or .bat).</param>
    /// <param name="dir">The project folder, checked to be inside the projects folder (or a bare repository of the git cache, inside it).</param>
    /// <param name="timeout">How long each git command may take.</param>
    /// <param name="bare">A bare repository of the git cache (1.6.0).</param>
    public GitReads(ICodeHost host, string git, string dir, TimeSpan timeout, bool bare = false)
    {
        _host = host;
        _git = git;
        _dir = dir;
        _timeout = timeout;
        _bare = bare;
    }

    /// <summary>The <c>code_git_graph</c> answer: HEAD, branches, tags, the newest <paramref name="limit"/> commits (topological order), the working tree's state (null in a bare repository) and the remotes.</summary>
    public async Task<JsonObject> GraphAsync(int limit, bool all, CancellationToken ct)
    {
        await RequireRepositoryAsync(ct);
        var head = await HeadAsync(ct);
        var (branches, tags) = GitOutput.ParseRefs(await GitAsync(["for-each-ref", GitOutput.RefFormat, "refs/heads", "refs/remotes", "refs/tags"], ct));
        var commits = await LogAsync(limit, all, head.Commit is not null, ct);
        var status = _bare ? null : GitOutput.ParseStatus(await GitAsync(["status", "--porcelain=v2", "-z", "--untracked-files=normal"], ct));
        var remotes = GitOutput.ParseRemotes(await GitAsync(["remote", "-v"], ct));

        var refs = RefsByCommit(head, branches, tags);
        var commitList = new JsonArray();
        foreach (var c in commits.Take(limit))
        {
            var item = CommitJson(c);
            item["refs"] = new JsonArray(refs.GetValueOrDefault(c.Hash, []).Select(r => (JsonNode)r).ToArray());
            commitList.Add(item);
        }

        return new JsonObject
        {
            ["head"] = new JsonObject { ["branch"] = head.Branch, ["commit"] = head.Commit, ["detached"] = head.Detached },
            ["branches"] = new JsonArray(branches.Take(MaxRefs).Select(b => (JsonNode)new JsonObject
            {
                ["name"] = b.Name,
                ["commit"] = b.Commit,
                ["remote"] = b.Remote,
                ["upstream"] = b.Upstream,
                ["ahead"] = b.Ahead,
                ["behind"] = b.Behind,
                ["current"] = b.Current,
            }).ToArray()),
            ["tags"] = new JsonArray(tags.Take(MaxRefs).Select(t => (JsonNode)new JsonObject { ["name"] = t.Name, ["commit"] = t.Commit }).ToArray()),
            ["commits"] = commitList,
            ["status"] = status is null ? null : new JsonObject
            {
                ["dirty"] = status.Dirty,
                ["staged"] = status.Staged,
                ["unstaged"] = status.Unstaged,
                ["untracked"] = status.Untracked,
                ["conflicted"] = status.Conflicted,
            },
            ["remotes"] = new JsonArray(remotes.Select(r => (JsonNode)new JsonObject { ["name"] = r.Name, ["url"] = r.Url }).ToArray()),
            ["truncated"] = commits.Count > limit,
        };
    }

    /// <summary>The <c>code_git_commit</c> answer: one commit's metadata and the files it changed (paths and line counts, no diff).</summary>
    public async Task<JsonObject> CommitAsync(string hash, CancellationToken ct)
    {
        await RequireRepositoryAsync(ct);
        var shown = await RunAsync(["show", "-s", "-z", "--no-show-signature", GitOutput.CommitFormat, hash, "--"], ct);
        if (shown.ExitCode != 0 || GitOutput.ParseCommit(shown.Stdout) is not { } parsed)
        {
            throw CommandException.NotFound($"There is no commit {hash} in this {(_bare ? "repository" : "project")}.");
        }

        var (commit, committerDate, body) = parsed;
        // Against the first parent (a merge: what it brought into its branch); a first commit against nothing.
        string[] range = commit.Parents.Count > 0 ? [commit.Parents[0], commit.Hash] : ["--root", commit.Hash];
        IReadOnlyList<GitFileChange> files;
        if (_bare)
        {
            files = GitOutput.ParseNameStatus(await GitAsync(["diff-tree", "-r", "-z", "--no-renames", "--no-commit-id", "--name-status", .. range], ct));
        }
        else
        {
            var numstat = await GitAsync(["diff-tree", "-r", "-z", "-M", "--no-commit-id", "--numstat", .. range], ct);
            var nameStatus = await GitAsync(["diff-tree", "-r", "-z", "-M", "--no-commit-id", "--name-status", .. range], ct);
            files = GitOutput.ParseFiles(numstat, nameStatus);
        }

        var answer = CommitJson(commit);
        answer["committer_date"] = committerDate;
        answer["body"] = body.Length > MaxBodyChars ? body[..MaxBodyChars] : body;
        answer["files"] = new JsonArray(files.Take(MaxFiles).Select(f => (JsonNode)new JsonObject
        {
            ["path"] = f.Path,
            ["status"] = f.Status,
            ["additions"] = f.Additions,
            ["deletions"] = f.Deletions,
        }).ToArray());
        answer["stats"] = new JsonObject
        {
            ["files"] = files.Count,
            ["additions"] = files.Sum(f => f.Additions ?? 0),
            ["deletions"] = files.Sum(f => f.Deletions ?? 0),
        };
        answer["truncated"] = files.Count > MaxFiles;
        return answer;
    }

    private sealed record Head(string? Branch, string? Commit, bool Detached);

    private async Task RequireRepositoryAsync(CancellationToken ct)
    {
        var inside = await RunAsync(["rev-parse", _bare ? "--is-bare-repository" : "--is-inside-work-tree"], ct);
        if (inside.ExitCode != 0 || inside.Stdout.Trim() != "true")
        {
            throw CommandException.Failed($"“{Path.GetFileName(_dir)}” isn't a git repository.");
        }
    }

    /// <summary>The branch HEAD is on (also an unborn one, in an empty repository) and its commit (null when there is none yet).</summary>
    private async Task<Head> HeadAsync(CancellationToken ct)
    {
        var symbolic = await RunAsync(["symbolic-ref", "-q", "--short", "HEAD"], ct);
        var branch = symbolic.ExitCode == 0 && symbolic.Stdout.Trim() is { Length: > 0 } b ? b : null;
        var verify = await RunAsync(["rev-parse", "-q", "--verify", "HEAD^{commit}"], ct);
        var commit = verify.ExitCode == 0 && verify.Stdout.Trim() is { Length: > 0 } c ? c : null;
        return new Head(branch, commit, branch is null && commit is not null);
    }

    /// <summary>One more than <paramref name="limit"/>, so the answer can say it was cut. None in a repository without commits.</summary>
    private async Task<IReadOnlyList<GitCommit>> LogAsync(int limit, bool all, bool hasHead, CancellationToken ct)
    {
        List<string> revisions = all ? ["--branches", "--remotes"] : [];
        if (hasHead)
        {
            revisions.Add("HEAD");
        }

        if (revisions.Count == 0)
        {
            return [];
        }

        var count = (limit + 1).ToString(CultureInfo.InvariantCulture);
        var output = await GitAsync(["log", "-z", "--topo-order", "--no-show-signature", "--max-count=" + count, GitOutput.LogFormat, .. revisions, "--"], ct);
        return GitOutput.ParseLog(output);
    }

    /// <summary>Each commit's names: <c>HEAD</c>, branches (<c>main</c>, <c>origin/main</c>) and tags (<c>tag: v1.0</c>), as git decorates them.</summary>
    private static Dictionary<string, List<string>> RefsByCommit(Head head, IReadOnlyList<GitBranch> branches, IReadOnlyList<GitTag> tags)
    {
        var refs = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        void Add(string commit, string name)
        {
            if (!refs.TryGetValue(commit, out var list))
            {
                refs[commit] = list = [];
            }

            list.Add(name);
        }

        if (head.Commit is not null)
        {
            Add(head.Commit, "HEAD");
        }

        foreach (var b in branches.Where(b => !b.Remote).Concat(branches.Where(b => b.Remote)))
        {
            Add(b.Commit, b.Name);
        }

        foreach (var t in tags)
        {
            Add(t.Commit, "tag: " + t.Name);
        }

        return refs;
    }

    private static JsonObject CommitJson(GitCommit c) => new()
    {
        ["hash"] = c.Hash,
        ["parents"] = new JsonArray(c.Parents.Select(p => (JsonNode)p).ToArray()),
        ["author_name"] = c.AuthorName,
        ["author_email"] = c.AuthorEmail,
        ["date"] = c.Date,
        ["subject"] = c.Subject,
    };

    /// <summary>A git command that must work; its error output is never passed on (it may name paths).</summary>
    private async Task<string> GitAsync(IReadOnlyList<string> args, CancellationToken ct)
    {
        var result = await RunAsync(args, ct);
        if (result.ExitCode != 0)
        {
            throw CommandException.Failed($"git {args[0]} failed in “{Path.GetFileName(_dir)}” (exit code {result.ExitCode}).");
        }

        return result.Stdout;
    }

    private async Task<ToolResult> RunAsync(IReadOnlyList<string> args, CancellationToken ct)
    {
        try
        {
            return await _host.RunAsync(new ToolRun(_git, [.. SafeOptions, .. args], _dir, Environment), _timeout, ct);
        }
        catch (TimeoutException)
        {
            throw CommandException.Failed($"git {args[0]} took longer than {_timeout.TotalSeconds:0} seconds in “{Path.GetFileName(_dir)}”.");
        }
    }
}
