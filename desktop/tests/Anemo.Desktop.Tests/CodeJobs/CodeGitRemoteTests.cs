using System.Text.Json.Nodes;
using Anemo.Desktop.Core.CodeJobs;
using Anemo.Desktop.Core.Commands;
using Anemo.Desktop.Core.Control;
using Anemo.Desktop.Core.Protocol;
using Anemo.Desktop.Core.Storage;
using Anemo.Desktop.Tests.Fakes;

namespace Anemo.Desktop.Tests.CodeJobs;

/// <summary>
/// Remote repositories, fetching and pull requests for the git reads (device-contracts.md
/// §7.6): which repositories may be read, the cache of bare clones, <c>fetch</c> on a local
/// checkout, <c>unauthenticated</c> and the pull requests.
/// </summary>
public sealed class CodeGitRemoteTests : IDisposable
{
    private static readonly DeviceInfo Trusted = new("dev-1", "Desk PC", "computer", "trusted");
    private static readonly DeviceInfo Watched = new("dev-1", "Desk PC", "computer", "watched");
    private const string Hash = "0123456789abcdef0123456789abcdef01234567";
    private const string Gh = @"C:\Program Files\GitHub CLI\gh.exe";
    private const string RepoList = """[{"name":"Anemo","url":"https://github.com/essntl/Anemo"},{"name":"notes","url":"https://github.com/essntl/notes"},{"name":"tools","url":"https://github.com/essntl/tools"},{"name":"extra","url":"https://github.com/essntl/extra"}]""";

    private const string PullRequestsJson = """
        [{"number":7,"title":"Add the git graph","headRefName":"feat/graph","url":"https://github.com/essntl/Anemo/pull/7","isDraft":true,"state":"OPEN"},
         {"number":8,"title":"Elsewhere","headRefName":"x","url":"https://evil.example/pull/8","isDraft":false,"state":"OPEN"}]
        """;

    private readonly JobsFolder _jobs = new();
    private readonly ManualTime _time = new();
    private readonly string _projects;
    private readonly string _cache;
    private CodeJobControl? _control;

    public CodeGitRemoteTests()
    {
        _projects = Path.Combine(_jobs.Root, "projects");
        _cache = Path.Combine(_jobs.Root, "app", "git-cache");
        Directory.CreateDirectory(Path.Combine(_projects, "anemo"));
        Settings = new DesktopSettings
        {
            ShareCodeJobs = true,
            StartCodeJobs = false,
            CodeJobsFolder = _jobs.Jobs,
            CodeProjectsFolder = _projects,
        };
        Host.Answer = Scripted;
    }

    private DesktopSettings Settings { get; set; }

    private FakeCodeHost Host { get; set; } = FakeCodeHost.WithEverything();

    private ICodeHost? RealHost { get; set; }

    private CodeJobControlOptions Options { get; set; } = new();

    private string Hooks => Path.Combine(_jobs.Root, "app", "git-no-hooks");

    /// <summary>Bytes each fake clone writes into its folder (and each fake fetch adds).</summary>
    private int CloneBytes { get; set; } = 100;

    private int FetchBytes { get; set; }

    private ToolResult CloneResult { get; set; } = new(0, "", "");

    private ToolResult FetchResult { get; set; } = new(0, "", "");

    public void Dispose()
    {
        foreach (var file in Directory.EnumerateFiles(_jobs.Root, "*", SearchOption.AllDirectories))
        {
            File.SetAttributes(file, FileAttributes.Normal);
        }

        _jobs.Dispose();
    }

    // -- which repositories ------------------------------------------------------------------

    [Theory]
    [InlineData("essntl")]
    [InlineData("essntl/")]
    [InlineData("/anemo")]
    [InlineData("essntl/..")]
    [InlineData("essntl/.")]
    [InlineData("essntl/anemo.git")]
    [InlineData("essntl/Anemo.GIT")]
    [InlineData("essntl/an/emo")]
    [InlineData("-essntl/anemo")]
    [InlineData("essntl/anemo;calc")]
    [InlineData("essntl/../anemo")]
    [InlineData("https://github.com/essntl/anemo")]
    public async Task A_repo_must_be_a_plain_owner_and_name(string repo)
    {
        var outcome = await RunAsync("code_git_graph", new JsonObject { ["repo"] = repo });

        Assert.False(outcome.Ok);
        Assert.Equal(ResultCodes.NotFound, outcome.Code);
        Assert.Empty(Host.Runs);
        Assert.False(Directory.Exists(_cache));
    }

    [Fact]
    public async Task Another_owners_repository_is_not_found()
    {
        var outcome = await RunAsync("code_git_graph", new JsonObject { ["repo"] = "someone/anemo" });

        Assert.Equal(ResultCodes.NotFound, outcome.Code);
        Assert.DoesNotContain(Host.Runs, r => Git(r) is not null);
    }

    [Fact]
    public async Task The_owner_from_settings_counts_without_asking_gh()
    {
        Settings = Settings with { GitHubOwner = "other" };

        var outcome = await RunAsync("code_git_graph", new JsonObject { ["repo"] = "essntl/anemo" });

        Assert.Equal(ResultCodes.NotFound, outcome.Code);
        Assert.Empty(Host.Runs);
    }

    [Fact]
    public async Task A_name_not_in_the_owners_list_is_not_found()
    {
        var outcome = await RunAsync("code_git_commit", new JsonObject { ["repo"] = "essntl/secret", ["hash"] = Hash });

        Assert.Equal(ResultCodes.NotFound, outcome.Code);
        Assert.DoesNotContain(Host.Runs, r => Git(r) is not null);
        Assert.False(Directory.Exists(Path.Combine(_cache, "essntl", "secret.git")));
    }

    [Theory]
    [InlineData(true, true)]
    [InlineData(false, false)]
    public async Task Exactly_one_of_project_and_repo(bool project, bool repo)
    {
        var fields = new JsonObject();
        if (project)
        {
            fields["project"] = "anemo";
        }

        if (repo)
        {
            fields["repo"] = "essntl/anemo";
        }

        var outcome = await RunAsync("code_git_graph", fields);

        Assert.Equal(ResultCodes.Failed, outcome.Code);
        Assert.Empty(Host.Runs);
    }

    [Fact]
    public async Task Remote_reads_need_sharing_and_a_trusted_device()
    {
        var watched = await RunAsync("code_git_graph", new JsonObject { ["repo"] = "essntl/anemo" }, Watched);
        var clear = await RunAsync("code_git_cache_clear", new JsonObject(), Watched);

        Assert.Equal(ResultCodes.Refused, watched.Code);
        Assert.Equal(ResultCodes.Refused, clear.Code);
        Assert.Empty(Host.Runs);
    }

    // -- the cache -----------------------------------------------------------------------------

    [Fact]
    public async Task A_repository_is_cloned_from_the_lists_url_into_a_temporary_folder_then_moved_into_place()
    {
        var outcome = await RunAsync("code_git_graph", new JsonObject { ["repo"] = "ESSNTL/anemo" });

        Assert.True(outcome.Ok, outcome.Error);
        var graph = (JsonObject)outcome.State!;
        Assert.Equal("remote", (string?)graph["source"]);
        Assert.Equal("essntl/Anemo", (string?)graph["repo"]);
        Assert.Null(graph["status"]);
        Assert.Null(graph["fetch_error"]);
        Assert.Equal("2026-11-22T10:00:00Z", (string?)graph["fetched_at"]);
        Assert.Equal("main", (string?)graph["head"]!["branch"]);

        var dir = Path.Combine(_cache, "essntl", "anemo.git");
        Assert.True(Directory.Exists(dir));
        Assert.Equal([dir], Directory.GetDirectories(Path.Combine(_cache, "essntl"))); // no temporary folder left

        var runs = Host.Runs.Where(r => Git(r) is not null).ToList();
        var clone = runs.Single(r => Git(r) == "clone");
        var temp = clone.Arguments[^1];
        Assert.Equal(["clone", "--bare", "--filter=blob:none", "--no-tags", "--", "https://github.com/essntl/Anemo", temp], clone.Arguments.Skip(GitReads.SafeOptions.Count + GitFetch.Options(Hooks).Count));
        Assert.Equal(Path.Combine(_cache, "essntl"), Path.GetDirectoryName(temp));
        Assert.Matches(@"^\.anemo\.git\.[0-9a-f]{8}\.tmp$", Path.GetFileName(temp));

        var fetch = runs.Single(r => Git(r) == "fetch");
        Assert.Equal(temp, fetch.WorkingDirectory); // fetched before it is moved into place
        Assert.Equal(GitRepoCache.FetchArguments, fetch.Arguments.Skip(GitReads.SafeOptions.Count + GitFetch.Options(Hooks).Count));
        Assert.All(new[] { clone, fetch }, run =>
        {
            Assert.Equal(GitReads.SafeOptions, run.Arguments.Take(GitReads.SafeOptions.Count));
            Assert.Equal(GitFetch.Options(Hooks), run.Arguments.Skip(GitReads.SafeOptions.Count).Take(GitFetch.Options(Hooks).Count));
            Assert.Equal("0", run.Environment["GIT_TERMINAL_PROMPT"]);
            Assert.Equal("1", run.Environment["GIT_NO_LAZY_FETCH"]);
        });
        Assert.Contains("core.hooksPath=" + Hooks, clone.Arguments);
        Assert.Contains("protocol.ext.allow=never", clone.Arguments);
        Assert.Contains("protocol.file.allow=never", clone.Arguments);
        Assert.True(Directory.Exists(Hooks));
        Assert.Empty(Directory.EnumerateFileSystemEntries(Hooks));

        // The reads are of the bare repository: no status, no work-tree check.
        var reads = runs.Where(r => Git(r) is not ("clone" or "fetch")).ToList();
        Assert.All(reads, r => Assert.Equal(dir, r.WorkingDirectory));
        Assert.Contains(reads, r => r.Arguments.Contains("--is-bare-repository"));
        Assert.DoesNotContain(reads, r => Git(r) == "status");

        var pulls = graph["pull_requests"]!.AsArray();
        Assert.Single(pulls);
        Assert.Equal(7, (int)pulls[0]!["number"]!);
        Assert.Equal("feat/graph", (string?)pulls[0]!["head_ref"]);
        Assert.True((bool)pulls[0]!["draft"]!);
        var pr = Host.Runs.Single(r => r.Arguments.FirstOrDefault() == "pr");
        Assert.Equal(GitHubPullRequests.Arguments("essntl/Anemo"), pr.Arguments);
    }

    [Fact]
    public async Task A_cached_repository_is_fetched_when_asked_or_after_ten_minutes()
    {
        async Task<int> FetchesAfter(JsonObject fields)
        {
            Assert.True((await RunAsync("code_git_graph", fields)).Ok);
            return Host.Runs.Count(r => Git(r) == "fetch");
        }

        var repo = new JsonObject { ["repo"] = "essntl/anemo" };
        Assert.Equal(1, await FetchesAfter(repo)); // the clone's
        Assert.Equal(1, await FetchesAfter(repo)); // fresh
        _time.Now += TimeSpan.FromMinutes(9);
        Assert.Equal(1, await FetchesAfter(repo));
        _time.Now += TimeSpan.FromMinutes(2);
        Assert.Equal(2, await FetchesAfter(repo)); // 11 minutes old
        Assert.Equal(2, await FetchesAfter(repo));
        Assert.Equal(3, await FetchesAfter(new JsonObject { ["repo"] = "essntl/anemo", ["fetch"] = true }));
        Assert.Single(Host.Runs, r => Git(r) == "clone");

        var graph = (JsonObject)(await RunAsync("code_git_graph", repo)).State!;
        Assert.Equal("2026-11-22T10:11:00Z", (string?)graph["fetched_at"]);

        // The owner's list is kept 10 minutes too.
        Assert.Equal(2, Host.Runs.Count(r => r.Arguments.FirstOrDefault() == "repo"));
    }

    [Fact]
    public async Task A_clone_that_takes_too_long_is_removed()
    {
        Host.AnswerAsync = (run, _) => Git(run) == "clone" ? throw new TimeoutException() : Task.FromResult(Scripted(run));

        var outcome = await RunAsync("code_git_graph", new JsonObject { ["repo"] = "essntl/anemo" });

        Assert.Equal(ResultCodes.Failed, outcome.Code);
        Assert.Equal("essntl/Anemo is too large to read without cloning.", outcome.Error);
        Assert.Empty(Directory.GetDirectories(Path.Combine(_cache, "essntl")));
    }

    [Fact]
    public async Task A_clone_over_the_size_cap_is_removed()
    {
        Options = new CodeJobControlOptions { GitCacheRepositoryMaxBytes = 1000 };
        CloneBytes = 2000;

        var outcome = await RunAsync("code_git_graph", new JsonObject { ["repo"] = "essntl/anemo" });

        Assert.Equal(ResultCodes.Failed, outcome.Code);
        Assert.Equal("essntl/Anemo is too large to read without cloning.", outcome.Error);
        Assert.Empty(Directory.GetDirectories(Path.Combine(_cache, "essntl")));
        Assert.DoesNotContain(Host.Runs, r => Git(r) == "rev-parse");
    }

    [Fact]
    public async Task A_fetch_that_grows_past_the_cap_removes_the_repository()
    {
        Options = new CodeJobControlOptions { GitCacheRepositoryMaxBytes = 1000 };
        Assert.True((await RunAsync("code_git_graph", new JsonObject { ["repo"] = "essntl/anemo" })).Ok);
        FetchBytes = 2000;

        var outcome = await RunAsync("code_git_graph", new JsonObject { ["repo"] = "essntl/anemo", ["fetch"] = true });

        Assert.Equal(ResultCodes.Failed, outcome.Code);
        Assert.False(Directory.Exists(Path.Combine(_cache, "essntl", "anemo.git")));
    }

    [Fact]
    public async Task The_least_recently_read_repositories_go_when_the_cache_is_full_never_the_one_just_read()
    {
        Options = new CodeJobControlOptions { GitCacheMaxBytes = 2500 };
        CloneBytes = 1000;
        async Task Read(string name)
        {
            Assert.True((await RunAsync("code_git_graph", new JsonObject { ["repo"] = "essntl/" + name })).Ok);
            _time.Now += TimeSpan.FromMinutes(1);
        }

        bool Cached(string name) => Directory.Exists(Path.Combine(_cache, "essntl", name + ".git"));

        await Read("anemo");
        await Read("notes");
        await Read("anemo"); // now notes is the least recently read
        await Read("tools");

        Assert.True(Cached("anemo"));
        Assert.False(Cached("notes"));
        Assert.True(Cached("tools"));

        // A cap smaller than one repository: everything else goes, the new one stays.
        Options = new CodeJobControlOptions { GitCacheMaxBytes = 10 };
        _control = null;
        await Read("extra");

        Assert.True(Cached("extra"));
        Assert.False(Cached("anemo"));
        Assert.False(Cached("tools"));
    }

    [Fact]
    public async Task Clearing_the_cache_removes_every_repository()
    {
        CloneBytes = 1000;
        Assert.True((await RunAsync("code_git_graph", new JsonObject { ["repo"] = "essntl/anemo" })).Ok);
        Assert.True((await RunAsync("code_git_graph", new JsonObject { ["repo"] = "essntl/notes" })).Ok);
        Directory.CreateDirectory(Path.Combine(_cache, "essntl", ".tools.git.0011223344556677.tmp")); // a clone stopped with the app

        var outcome = await RunAsync("code_git_cache_clear", new JsonObject());

        Assert.True(outcome.Ok, outcome.Error);
        Assert.Equal(2, (int)outcome.State!["removed"]!);
        Assert.True((long)outcome.State!["bytes"]! >= 2000);
        Assert.Empty(Directory.EnumerateFileSystemEntries(_cache));

        var again = await RunAsync("code_git_cache_clear", new JsonObject());
        Assert.Equal(0, (int)again.State!["removed"]!);
        Assert.Equal(0, (long)again.State!["bytes"]!);
    }

    [Fact]
    public async Task A_link_out_of_the_cache_folder_is_refused()
    {
        var outside = Path.Combine(_jobs.Root, "outside");
        Directory.CreateDirectory(outside);
        Directory.CreateDirectory(_cache);
        var link = Path.Combine(_cache, "essntl");
        if (!MakeLink(link, outside))
        {
            return; // neither a symbolic link nor a junction can be made here
        }

        try
        {
            await LinkedCacheIsLeftAlone(outside);
        }
        finally
        {
            Directory.Delete(link); // the link only; the test folder's clean-up won't remove a junction
        }
    }

    private async Task LinkedCacheIsLeftAlone(string outside)
    {
        var outcome = await RunAsync("code_git_graph", new JsonObject { ["repo"] = "essntl/anemo" });

        Assert.Equal(ResultCodes.Refused, outcome.Code);
        Assert.DoesNotContain(Host.Runs, r => Git(r) is not null);

        // Nor does a clear reach through it.
        File.WriteAllText(Path.Combine(outside, "keep.txt"), "mine");
        Directory.CreateDirectory(Path.Combine(outside, "x.git"));
        await RunAsync("code_git_cache_clear", new JsonObject());
        Assert.True(File.Exists(Path.Combine(outside, "keep.txt")));
        Assert.True(Directory.Exists(Path.Combine(outside, "x.git")));
    }

    // -- unauthenticated -----------------------------------------------------------------------

    [Theory]
    [InlineData("fatal: could not read Username for 'https://github.com': terminal prompts disabled", ResultCodes.Unauthenticated)]
    [InlineData("remote: Repository not found.\nfatal: repository 'https://github.com/essntl/Anemo/' not found", ResultCodes.Unauthenticated)]
    [InlineData("fatal: Authentication failed for 'https://github.com/essntl/Anemo/'", ResultCodes.Unauthenticated)]
    [InlineData("fatal: unable to access 'https://github.com/essntl/Anemo/': Could not resolve host: github.com", ResultCodes.Failed)]
    public async Task A_clone_refused_for_want_of_a_sign_in_is_unauthenticated(string stderr, string code)
    {
        CloneResult = new ToolResult(128, "", stderr);

        var outcome = await RunAsync("code_git_graph", new JsonObject { ["repo"] = "essntl/anemo" });

        Assert.Equal(code, outcome.Code);
        Assert.DoesNotContain("fatal", outcome.Error);
        Assert.DoesNotContain("github.com", outcome.Error);
        Assert.Empty(Directory.GetDirectories(Path.Combine(_cache, "essntl")));
    }

    [Fact]
    public async Task A_refetch_refused_for_a_sign_in_is_unauthenticated_and_any_other_failure_a_fetch_error()
    {
        Assert.True((await RunAsync("code_git_graph", new JsonObject { ["repo"] = "essntl/anemo" })).Ok);

        FetchResult = new ToolResult(128, "", "fatal: Authentication failed for 'https://github.com/essntl/Anemo/'");
        var refused = await RunAsync("code_git_graph", new JsonObject { ["repo"] = "essntl/anemo", ["fetch"] = true });
        Assert.Equal(ResultCodes.Unauthenticated, refused.Code);

        FetchResult = new ToolResult(128, "", "fatal: unable to access: Could not resolve host: github.com");
        var stale = await RunAsync("code_git_graph", new JsonObject { ["repo"] = "essntl/anemo", ["fetch"] = true });
        Assert.True(stale.Ok, stale.Error);
        Assert.Equal("The fetch from GitHub failed (exit code 128), so this is what the cache had before.", (string?)stale.State!["fetch_error"]);
        Assert.Equal("2026-11-22T10:00:00Z", (string?)stale.State!["fetched_at"]);
        Assert.True(Directory.Exists(Path.Combine(_cache, "essntl", "anemo.git")));
    }

    // -- fetch on a local checkout ---------------------------------------------------------------

    [Fact]
    public async Task Fetch_on_a_local_checkout_runs_a_fixed_fetch_first_without_hooks()
    {
        var repo = LocalCheckout("https://github.com/essntl/anemo.git");
        var fetchedAt = new DateTime(2026, 11, 20, 8, 30, 0, DateTimeKind.Utc);
        File.WriteAllText(Path.Combine(repo, ".git", "FETCH_HEAD"), "");
        File.SetLastWriteTimeUtc(Path.Combine(repo, ".git", "FETCH_HEAD"), fetchedAt);

        var outcome = await RunAsync("code_git_graph", new JsonObject { ["project"] = "anemo", ["fetch"] = true });

        Assert.True(outcome.Ok, outcome.Error);
        var runs = Host.Runs.Where(r => Git(r) is not null).ToList();
        var fetch = runs[0];
        Assert.Equal(
            [.. GitReads.SafeOptions,
             "-c", "core.hooksPath=" + Hooks, "-c", "protocol.ext.allow=never", "-c", "protocol.file.allow=never",
             "-c", "fetch.recurseSubmodules=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0",
             "fetch", "--prune", "--all", "--no-recurse-submodules"],
            fetch.Arguments);
        Assert.Equal(repo, fetch.WorkingDirectory);
        Assert.Equal(GitReads.Environment.OrderBy(e => e.Key), fetch.Environment.OrderBy(e => e.Key));
        Assert.Single(runs, r => Git(r) == "fetch");
        Assert.False(FolderLinks.IsInside(_projects, Hooks));

        var graph = (JsonObject)outcome.State!;
        Assert.Equal("local", (string?)graph["source"]);
        Assert.Equal("essntl/anemo", (string?)graph["repo"]);
        Assert.Equal("2026-11-20T08:30:00Z", (string?)graph["fetched_at"]);
        Assert.Null(graph["fetch_error"]);
        Assert.NotNull(graph["status"]);
        Assert.Single(graph["pull_requests"]!.AsArray());
    }

    [Fact]
    public async Task Without_fetch_nothing_is_fetched_and_a_never_fetched_checkout_has_no_time()
    {
        LocalCheckout("git@gitlab.com:essntl/anemo.git");

        var graph = (JsonObject)(await RunAsync("code_git_graph", new JsonObject { ["project"] = "anemo" })).State!;

        Assert.DoesNotContain(Host.Runs, r => Git(r) == "fetch");
        Assert.Equal("local", (string?)graph["source"]);
        Assert.Null(graph["repo"]); // not on github.com: no pull requests either
        Assert.Null(graph["fetched_at"]);
        Assert.Null(graph["fetch_error"]);
        Assert.Null(graph["pull_requests"]);
        Assert.DoesNotContain(Host.Runs, r => r.FileName == Gh);
    }

    [Theory]
    [InlineData(true, "The fetch took longer than 60 seconds, so this is what the repository had before.")]
    [InlineData(false, "The fetch failed (exit code 1), so this is what the repository had before.")]
    public async Task A_local_fetch_that_fails_still_answers_the_graph(bool timeout, string error)
    {
        LocalCheckout("https://github.com/essntl/anemo.git");
        Host.AnswerAsync = (run, _) => Git(run) == "fetch"
            ? (timeout ? throw new TimeoutException() : Task.FromResult(new ToolResult(1, "", "fatal: something /home/me/secret")))
            : Task.FromResult(Scripted(run));

        var outcome = await RunAsync("code_git_graph", new JsonObject { ["project"] = "anemo", ["fetch"] = true });

        Assert.True(outcome.Ok, outcome.Error);
        Assert.Equal(error, (string?)outcome.State!["fetch_error"]);
        Assert.NotEmpty(outcome.State!["commits"]!.AsArray());
    }

    [Fact]
    public async Task A_local_fetch_refused_for_a_sign_in_is_a_fetch_error()
    {
        LocalCheckout("https://github.com/essntl/anemo.git");
        FetchResult = new ToolResult(128, "", "fatal: could not read Username for 'https://github.com': terminal prompts disabled");

        var outcome = await RunAsync("code_git_graph", new JsonObject { ["project"] = "anemo", ["fetch"] = true });

        Assert.True(outcome.Ok, outcome.Error);
        Assert.Equal("git isn't signed in for this repository's remote on this computer, so it wasn't fetched.", (string?)outcome.State!["fetch_error"]);
    }

    // -- pull requests -----------------------------------------------------------------------------

    [Fact]
    public async Task Pull_requests_are_null_without_gh_or_when_gh_fails_or_takes_too_long()
    {
        LocalCheckout("https://github.com/essntl/anemo.git");
        Host.OnPath.TryRemove("gh", out _);
        Assert.Null((await RunAsync("code_git_graph", new JsonObject { ["project"] = "anemo" })).State!["pull_requests"]);

        Host.OnPath["gh"] = Gh;
        _control = null;
        Host.AnswerAsync = (run, _) => run.FileName == Gh ? throw new TimeoutException() : Task.FromResult(Scripted(run));
        var timedOut = await RunAsync("code_git_graph", new JsonObject { ["project"] = "anemo" });
        Assert.True(timedOut.Ok, timedOut.Error);
        Assert.Null(timedOut.State!["pull_requests"]);

        _control = null;
        Host.AnswerAsync = (run, _) => Task.FromResult(run.FileName == Gh ? new ToolResult(1, "", "gh auth login") : Scripted(run));
        Assert.Null((await RunAsync("code_git_graph", new JsonObject { ["project"] = "anemo" })).State!["pull_requests"]);
    }

    [Fact]
    public async Task Pull_requests_are_kept_two_minutes_unless_the_read_fetches()
    {
        LocalCheckout("https://github.com/essntl/anemo.git");
        int Asked() => Host.Runs.Count(r => r.FileName == Gh && r.Arguments[0] == "pr");

        await RunAsync("code_git_graph", new JsonObject { ["project"] = "anemo" });
        await RunAsync("code_git_graph", new JsonObject { ["project"] = "anemo" });
        Assert.Equal(1, Asked());
        _time.Now += TimeSpan.FromMinutes(3);
        var later = await RunAsync("code_git_graph", new JsonObject { ["project"] = "anemo" });
        Assert.Equal(2, Asked());
        Assert.Single(later.State!["pull_requests"]!.AsArray());
        await RunAsync("code_git_graph", new JsonObject { ["project"] = "anemo", ["fetch"] = true });
        Assert.Equal(3, Asked());
    }

    [Fact]
    public void Pull_requests_are_read_defensively()
    {
        Assert.Null(GitHubPullRequests.Parse("not json"));
        Assert.Null(GitHubPullRequests.Parse("""{"number":1}"""));
        Assert.Empty(GitHubPullRequests.Parse("[]")!);

        var list = GitHubPullRequests.Parse("""
            [{"number":1,"title":"Fine","headRefName":"a","url":"https://github.com/o/r/pull/1","isDraft":false,"state":"OPEN"},
             {"number":2,"title":"Closed","headRefName":"b","url":"https://github.com/o/r/pull/2","isDraft":false,"state":"CLOSED"},
             {"number":3,"title":"Other host","headRefName":"c","url":"http://github.com/o/r/pull/3","state":"OPEN"},
             {"number":"4","title":"Number as text","headRefName":"d","url":"https://github.com/o/r/pull/4","state":"OPEN"},
             {"number":5,"title":null,"headRefName":"e","url":"https://github.com/o/r/pull/5","state":"OPEN"},
             {"number":6,"title":"No draft field","headRefName":"f","url":"https://github.com/o/r/pull/6","state":"OPEN"},
             "junk", 7, null]
            """)!;

        Assert.Equal([1, 6], list.Select(p => p.Number));
        Assert.False(list[1].Draft);

        var many = new JsonArray(Enumerable.Range(1, 150).Select(i => (JsonNode)new JsonObject
        {
            ["number"] = i,
            ["title"] = new string('t', 400),
            ["headRefName"] = "b" + i,
            ["url"] = $"https://github.com/o/r/pull/{i}",
            ["isDraft"] = false,
            ["state"] = "OPEN",
        }).ToArray());
        var capped = GitHubPullRequests.Parse(many.ToJsonString())!;
        Assert.Equal(GitHubPullRequests.MaxPullRequests, capped.Count);
        Assert.All(capped, p => Assert.Equal(GitHubPullRequests.MaxTitleChars, p.Title.Length));
    }

    [Theory]
    [InlineData("https://github.com/essntl/anemo.git", "essntl/anemo")]
    [InlineData("https://user:token@github.com/essntl/anemo", "essntl/anemo")]
    [InlineData("https://GitHub.com/essntl/anemo/", "essntl/anemo")]
    [InlineData("git@github.com:essntl/anemo.git", "essntl/anemo")]
    [InlineData("ssh://git@github.com/essntl/anemo.git", "essntl/anemo")]
    [InlineData("https://gitlab.com/essntl/anemo.git", null)]
    [InlineData("https://github.com.evil.example/essntl/anemo.git", null)]
    [InlineData("https://github.com/essntl/anemo/tree/main", null)]
    [InlineData("C:\\dev\\anemo", null)]
    [InlineData(null, null)]
    public void A_github_origin_gives_owner_and_name(string? url, string? repo)
    {
        Assert.Equal(repo, GitHubRepo.FromUrl(url));
    }

    // -- a bare cache read against a real git ---------------------------------------------------------

    [Fact]
    public async Task A_real_bare_blobless_clone_reads_without_status_or_line_counts()
    {
        if (CodeGitTests.RealGit.Find() is not { } git)
        {
            return;
        }

        var source = Path.Combine(_jobs.Root, "source");
        Directory.CreateDirectory(source);
        void Run(string dir, params string[] args) => CodeGitTests.RealGit.Run(git, dir, args);
        Run(source, "init", "-q", "-b", "main");
        Run(source, "config", "user.name", "Test");
        Run(source, "config", "user.email", "test@example.com");
        Run(source, "config", "commit.gpgsign", "false");
        File.WriteAllText(Path.Combine(source, "a.txt"), "one\n");
        Run(source, "add", "a.txt");
        Run(source, "commit", "-q", "-m", "First");
        File.WriteAllText(Path.Combine(source, "a.txt"), "one\ntwo\n");
        File.WriteAllText(Path.Combine(source, "b.txt"), "new\n");
        Run(source, "add", "a.txt", "b.txt");
        Run(source, "commit", "-q", "-m", "Second");
        Run(source, "tag", "v1");

        // The cache's repository made directly (a file:// clone is what the cache itself refuses).
        var owner = Path.Combine(_cache, "essntl");
        Directory.CreateDirectory(owner);
        Run(owner, "clone", "-q", "--bare", "--filter=blob:none", "--no-tags", new Uri(source).AbsoluteUri, "anemo.git");
        var dir = Path.Combine(owner, "anemo.git");
        File.WriteAllText(Path.Combine(dir, GitRepoCache.FetchedFile), "");
        File.SetLastWriteTimeUtc(Path.Combine(dir, GitRepoCache.FetchedFile), _time.Now.UtcDateTime);

        Settings = Settings with { GitHubOwner = "essntl" };
        RealHost = new GitAndFakeGh(new CodeGitTests.RealGit(git), RepoList);

        var outcome = await RunAsync("code_git_graph", new JsonObject { ["repo"] = "essntl/anemo" });

        Assert.True(outcome.Ok, outcome.Error);
        var graph = (JsonObject)outcome.State!;
        Assert.Null(graph["status"]);
        Assert.Equal("remote", (string?)graph["source"]);
        Assert.Equal("main", (string?)graph["head"]!["branch"]);
        var branch = Assert.Single(graph["branches"]!.AsArray());
        Assert.False((bool)branch!["remote"]!);
        Assert.Null(branch["upstream"]);
        var commits = graph["commits"]!.AsArray();
        Assert.Equal(["Second", "First"], commits.Select(c => (string?)c!["subject"]));

        var commit = await RunAsync("code_git_commit", new JsonObject { ["repo"] = "essntl/anemo", ["hash"] = (string)commits[0]!["hash"]! });
        Assert.True(commit.Ok, commit.Error);
        var files = commit.State!["files"]!.AsArray();
        Assert.Equal(["a.txt", "b.txt"], files.Select(f => (string?)f!["path"]));
        Assert.Equal(["M", "A"], files.Select(f => (string?)f!["status"]));
        Assert.All(files, f =>
        {
            Assert.Null(f!["additions"]);
            Assert.Null(f["deletions"]);
        });
        Assert.Equal(2, (int)commit.State!["stats"]!["files"]!);
        Assert.Equal(0, (int)commit.State!["stats"]!["additions"]!);
    }

    // -- helpers ---------------------------------------------------------------------------------

    private Task<CommandOutcome> RunAsync(string action, JsonObject fields, DeviceInfo? device = null)
    {
        _control ??= new CodeJobControl(() => Settings, RealHost ?? Host, new FakeProcesses(), _time, Options, gitCacheFolder: _cache);
        var processor = new CommandProcessor(new FakePlatform().Services, new ControlState(_time, allow: true, pausedUntil: null), () => Settings, new CommandLog(Path.Combine(_jobs.Root, "log"), _time), null, _control);
        var command = new JsonObject { ["type"] = "device.command", ["id"] = Guid.NewGuid().ToString(), ["action"] = action };
        foreach (var (key, value) in fields)
        {
            command[key] = value?.DeepClone();
        }

        return processor.ExecuteAsync(command, device ?? Trusted, CancellationToken.None);
    }

    /// <summary>A symbolic link, or where this Windows account may not make one, a junction (which needs no rights).</summary>
    private static bool MakeLink(string link, string target)
    {
        try
        {
            Directory.CreateSymbolicLink(link, target);
            return true;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            if (!OperatingSystem.IsWindows())
            {
                return false;
            }
        }

        var info = new System.Diagnostics.ProcessStartInfo("cmd.exe") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true };
        foreach (var arg in new[] { "/d", "/c", "mklink", "/J", link, target })
        {
            info.ArgumentList.Add(arg);
        }

        using var process = System.Diagnostics.Process.Start(info)!;
        process.StandardOutput.ReadToEnd();
        process.WaitForExit();
        return process.ExitCode == 0 && Directory.Exists(link);
    }

    /// <summary>The projects folder's "anemo" as a checkout whose origin is <paramref name="origin"/>.</summary>
    private string LocalCheckout(string origin)
    {
        var repo = Path.Combine(_projects, "anemo");
        Directory.CreateDirectory(Path.Combine(repo, ".git"));
        File.WriteAllText(Path.Combine(repo, ".git", "config"), $"[remote \"origin\"]\n\turl = {origin}\n");
        return repo;
    }

    /// <summary>The git subcommand of a run (after the -c options), or null for gh.</summary>
    private static string? Git(ToolRun run)
    {
        if (run.FileName == Gh)
        {
            return null;
        }

        for (var i = 0; i < run.Arguments.Count; i++)
        {
            if (run.Arguments[i] == "-c")
            {
                i++;
            }
            else if (!run.Arguments[i].StartsWith("--", StringComparison.Ordinal))
            {
                return run.Arguments[i];
            }
        }

        return null;
    }

    /// <summary>gh and git as a signed-in computer with the owner essntl would answer them.</summary>
    private ToolResult Scripted(ToolRun run)
    {
        if (run.FileName == Gh)
        {
            return run.Arguments switch
            {
                ["api", "user", ..] => new ToolResult(0, "essntl\n", ""),
                ["repo", "list", "essntl", ..] => new ToolResult(0, RepoList, ""),
                ["pr", "list", ..] => new ToolResult(0, PullRequestsJson, ""),
                _ => new ToolResult(1, "", "unknown"),
            };
        }

        switch (Git(run))
        {
            case "clone":
                if (CloneResult.ExitCode == 0)
                {
                    Directory.CreateDirectory(run.Arguments[^1]);
                    File.WriteAllBytes(Path.Combine(run.Arguments[^1], "pack"), new byte[CloneBytes]);
                }

                return CloneResult;
            case "fetch":
                if (FetchResult.ExitCode == 0 && FetchBytes > 0)
                {
                    File.WriteAllBytes(Path.Combine(run.WorkingDirectory, "more"), new byte[FetchBytes]);
                }

                return FetchResult;
            case "rev-parse" when run.Arguments.Contains("--is-bare-repository") || run.Arguments.Contains("--is-inside-work-tree"):
                return new ToolResult(0, "true\n", "");
            case "symbolic-ref":
                return new ToolResult(0, "main\n", "");
            case "rev-parse":
                return new ToolResult(0, Hash + "\n", "");
            case "log":
                return new ToolResult(0, $"{Hash}\0\0Olena\0olena@example.com\02026-11-22T10:00:00+00:00\0First\0", "");
            default:
                return new ToolResult(0, "", "");
        }
    }

    /// <summary>The real git, and a gh that only lists <paramref name="repoList"/> (no pull requests).</summary>
    private sealed class GitAndFakeGh(ICodeHost git, string repoList) : ICodeHost
    {
        public string? FindOnPath(string program) => program == "gh" ? Gh : git.FindOnPath(program);

        public Task<ToolResult> RunAsync(ToolRun run, TimeSpan timeout, CancellationToken ct) => run.FileName == Gh
            ? Task.FromResult(run.Arguments[0] == "repo" ? new ToolResult(0, repoList, "") : new ToolResult(1, "", ""))
            : git.RunAsync(run, timeout, ct);

        public int StartJob(JobLaunch launch) => throw new InvalidOperationException();

        public bool KillTree(int pid) => false;
    }
}
