using System.Diagnostics;
using System.Text.Json.Nodes;
using Anemo.Desktop.Core.CodeJobs;
using Anemo.Desktop.Core.Commands;
using Anemo.Desktop.Core.Control;
using Anemo.Desktop.Core.Protocol;
using Anemo.Desktop.Core.Storage;
using Anemo.Desktop.Tests.Fakes;

namespace Anemo.Desktop.Tests.CodeJobs;

/// <summary>code_git_graph and code_git_commit (device-contracts.md §7.5): who may read, which folders, which git commands.</summary>
public sealed class CodeGitTests : IDisposable
{
    private static readonly DeviceInfo Trusted = new("dev-1", "Desk PC", "computer", "trusted");
    private static readonly DeviceInfo Watched = new("dev-1", "Desk PC", "computer", "watched");
    private const string Hash = "0123456789abcdef0123456789abcdef01234567";

    private readonly JobsFolder _jobs = new();
    private readonly ManualTime _time = new();
    private readonly string _projects;
    private ICodeHost _host = FakeCodeHost.WithEverything();

    public CodeGitTests()
    {
        _projects = Path.Combine(_jobs.Root, "projects");
        Directory.CreateDirectory(Path.Combine(_projects, "anemo"));
        Settings = new DesktopSettings
        {
            ShareCodeJobs = true,
            StartCodeJobs = false,
            CodeJobsFolder = _jobs.Jobs,
            CodeProjectsFolder = _projects,
        };
    }

    private DesktopSettings Settings { get; set; }

    private FakeCodeHost Fake => (FakeCodeHost)_host;

    public void Dispose()
    {
        // git keeps its objects read-only, which Windows won't delete as they are.
        foreach (var file in Directory.EnumerateFiles(_jobs.Root, "*", SearchOption.AllDirectories))
        {
            File.SetAttributes(file, FileAttributes.Normal);
        }

        _jobs.Dispose();
    }

    [Theory]
    [InlineData("code_git_graph")]
    [InlineData("code_git_commit")]
    public async Task Reads_need_a_trusted_device_and_sharing_but_not_the_start_setting(string action)
    {
        var fields = new JsonObject { ["project"] = "anemo", ["hash"] = Hash };

        Refused(await RunAsync(action, fields, Watched), CodeJobControl.NotTrustedMessage);
        Settings = Settings with { ShareCodeJobs = false };
        Refused(await RunAsync(action, fields), CodeJobControl.ShareOffMessage);
        Assert.Empty(Fake.Runs);
    }

    [Theory]
    [InlineData("..")]
    [InlineData("../anemo")]
    [InlineData("..\\anemo")]
    [InlineData("/etc")]
    [InlineData("C:\\Windows")]
    [InlineData("anemo/.git")]
    [InlineData(".git")]
    [InlineData("")]
    public async Task A_project_is_a_plain_folder_name(string project)
    {
        var outcome = await RunAsync("code_git_graph", new JsonObject { ["project"] = project });

        Assert.False(outcome.Ok);
        Assert.Equal(ResultCodes.Failed, outcome.Code);
        Assert.Empty(Fake.Runs);
    }

    [Fact]
    public async Task A_missing_project_is_not_found()
    {
        var outcome = await RunAsync("code_git_graph", new JsonObject { ["project"] = "nope" });

        Assert.False(outcome.Ok);
        Assert.Equal(ResultCodes.NotFound, outcome.Code);
        Assert.Empty(Fake.Runs);
    }

    [Fact]
    public async Task A_link_out_of_the_projects_folder_is_refused()
    {
        var outside = Path.Combine(_jobs.Root, "outside");
        Directory.CreateDirectory(outside);
        try
        {
            Directory.CreateSymbolicLink(Path.Combine(_projects, "escape"), outside);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return; // this Windows account may not make symbolic links
        }

        var outcome = await RunAsync("code_git_graph", new JsonObject { ["project"] = "escape" });

        Assert.False(outcome.Ok);
        Assert.Equal(ResultCodes.Refused, outcome.Code);
        Assert.Empty(Fake.Runs);
    }

    [Theory]
    [InlineData("HEAD")]
    [InlineData("--output=/tmp/x")]
    [InlineData("abc12")]
    [InlineData("ABCDEF1")]
    [InlineData("main")]
    public async Task A_commit_is_named_by_its_hash_only(string hash)
    {
        var outcome = await RunAsync("code_git_commit", new JsonObject { ["project"] = "anemo", ["hash"] = hash });

        Assert.False(outcome.Ok);
        Assert.Equal("“hash” must be 7 to 40 lower-case hexadecimal digits.", outcome.Error);
        Assert.Empty(Fake.Runs);
    }

    [Fact]
    public async Task The_limit_is_checked()
    {
        var outcome = await RunAsync("code_git_graph", new JsonObject { ["project"] = "anemo", ["limit"] = 1001 });

        Assert.False(outcome.Ok);
        Assert.Empty(Fake.Runs);
    }

    [Fact]
    public async Task Only_fixed_read_commands_run_as_argument_lists_in_the_project()
    {
        Fake.Answer = run => run.Arguments[GitReads.SafeOptions.Count] switch
        {
            "rev-parse" when run.Arguments.Contains("--is-inside-work-tree") => new ToolResult(0, "true\n", ""),
            "symbolic-ref" => new ToolResult(0, "main\n", ""),
            "rev-parse" => new ToolResult(0, Hash + "\n", ""),
            _ => new ToolResult(0, "", ""),
        };

        var outcome = await RunAsync("code_git_graph", new JsonObject { ["project"] = "anemo", ["limit"] = 5, ["all"] = false });

        Assert.True(outcome.Ok, outcome.Error);
        var runs = Fake.Runs.ToList();
        Assert.All(runs, run =>
        {
            Assert.Equal(@"C:\Program Files\Git\cmd\git.exe", run.FileName);
            Assert.Equal(Path.Combine(_projects, "anemo"), run.WorkingDirectory);
            Assert.Equal(GitReads.SafeOptions, run.Arguments.Take(GitReads.SafeOptions.Count));
            Assert.Equal("C", run.Environment["LC_ALL"]);
            Assert.Equal("0", run.Environment["GIT_TERMINAL_PROMPT"]);
        });
        Assert.Equal(
            ["rev-parse", "symbolic-ref", "rev-parse", "for-each-ref", "log", "status", "remote"],
            runs.Select(r => r.Arguments[GitReads.SafeOptions.Count]));
        var log = runs.Single(r => r.Arguments.Contains("log")).Arguments;
        Assert.Contains("--max-count=6", log);
        Assert.Contains("--topo-order", log);
        Assert.DoesNotContain("--branches", log);
        Assert.Equal(["HEAD", "--"], log.TakeLast(2));
    }

    [Fact]
    public async Task A_folder_that_is_no_repository_says_so()
    {
        Fake.Answer = _ => new ToolResult(128, "", "fatal: not a git repository");

        var outcome = await RunAsync("code_git_graph", new JsonObject { ["project"] = "anemo" });

        Assert.False(outcome.Ok);
        Assert.Equal("“anemo” isn't a git repository.", outcome.Error);
    }

    // -- against a real git, where there is one ----------------------------------------------

    [Fact]
    public async Task A_real_repository_reads_with_merges_tags_detached_head_and_dirty_state()
    {
        if (RealGit.Find() is not { } git)
        {
            return;
        }

        _host = new RealGit(git);
        var repo = Path.Combine(_projects, "anemo");
        void Run(params string[] args) => RealGit.Run(git, repo, args);
        Run("init", "-q", "-b", "main");
        Run("config", "user.name", "Олена Тест");
        Run("config", "user.email", "olena@example.com");
        Run("config", "commit.gpgsign", "false");
        File.WriteAllText(Path.Combine(repo, "a.txt"), "one\n");
        Run("add", "a.txt");
        Run("commit", "-q", "-m", "First: “quotes”\tand tabs");
        Run("checkout", "-q", "-b", "feat/ünïcode");
        File.WriteAllText(Path.Combine(repo, "b.txt"), "two\nthree\n");
        Run("add", "b.txt");
        Run("commit", "-q", "-m", "Feature");
        Run("checkout", "-q", "main");
        File.WriteAllText(Path.Combine(repo, "a.txt"), "one\nmore\n");
        Run("commit", "-q", "-am", "Main work");
        Run("merge", "-q", "--no-ff", "-m", "Merge feature", "feat/ünïcode");
        Run("tag", "-a", "v1.0", "-m", "Release");
        Run("remote", "add", "origin", "https://user:secret@github.com/essntl/anemo.git");
        File.WriteAllText(Path.Combine(repo, "a.txt"), "changed\n");
        File.WriteAllText(Path.Combine(repo, "new.txt"), "untracked\n");

        var graph = (JsonObject)(await RunAsync("code_git_graph", new JsonObject { ["project"] = "anemo" })).State!;

        Assert.Equal("main", (string?)graph["head"]!["branch"]);
        Assert.False((bool)graph["head"]!["detached"]!);
        var commits = graph["commits"]!.AsArray();
        Assert.Equal(4, commits.Count);
        Assert.Equal("Merge feature", (string?)commits[0]!["subject"]);
        Assert.Equal(2, commits[0]!["parents"]!.AsArray().Count);
        Assert.Equal(["HEAD", "main", "tag: v1.0"], commits[0]!["refs"]!.AsArray().Select(r => (string)r!));
        Assert.Equal("First: “quotes”\tand tabs", (string?)commits[^1]!["subject"]);
        Assert.Equal("Олена Тест", (string?)commits[^1]!["author_name"]);
        Assert.Contains(graph["branches"]!.AsArray(), b => (string?)b!["name"] == "feat/ünïcode");
        Assert.Equal("https://github.com/essntl/anemo.git", (string?)graph["remotes"]![0]!["url"]);
        Assert.True((bool)graph["status"]!["dirty"]!);
        Assert.Equal(1, (int)graph["status"]!["unstaged"]!);
        Assert.Equal(1, (int)graph["status"]!["untracked"]!);
        Assert.False((bool)graph["truncated"]!);

        var merge = (string)commits[0]!["hash"]!;
        var commit = (JsonObject)(await RunAsync("code_git_commit", new JsonObject { ["project"] = "anemo", ["hash"] = merge[..12] })).State!;
        Assert.Equal(merge, (string?)commit["hash"]);
        Assert.Equal("b.txt", (string?)commit["files"]![0]!["path"]);
        Assert.Equal("A", (string?)commit["files"]![0]!["status"]);
        Assert.Equal(2, (int)commit["stats"]!["additions"]!);

        // Detached at the first commit, only HEAD's history.
        Run("checkout", "-q", "-f", "--detach", (string)commits[^1]!["hash"]!);
        var detached = (JsonObject)(await RunAsync("code_git_graph", new JsonObject { ["project"] = "anemo", ["all"] = false })).State!;
        Assert.Null((string?)detached["head"]!["branch"]);
        Assert.True((bool)detached["head"]!["detached"]!);
        Assert.Single(detached["commits"]!.AsArray());

        var limited = (JsonObject)(await RunAsync("code_git_graph", new JsonObject { ["project"] = "anemo", ["limit"] = 2 })).State!;
        Assert.Equal(2, limited["commits"]!.AsArray().Count);
        Assert.True((bool)limited["truncated"]!);

        var missing = await RunAsync("code_git_commit", new JsonObject { ["project"] = "anemo", ["hash"] = "1234567" });
        Assert.Equal(ResultCodes.NotFound, missing.Code);
    }

    [Fact]
    public async Task A_real_empty_repository_has_no_commits_and_no_remote()
    {
        if (RealGit.Find() is not { } git)
        {
            return;
        }

        _host = new RealGit(git);
        RealGit.Run(git, Path.Combine(_projects, "anemo"), "init", "-q", "-b", "main");

        var outcome = await RunAsync("code_git_graph", new JsonObject { ["project"] = "anemo" });

        Assert.True(outcome.Ok, outcome.Error);
        var graph = (JsonObject)outcome.State!;
        Assert.Equal("main", (string?)graph["head"]!["branch"]);
        Assert.Null((string?)graph["head"]!["commit"]);
        Assert.Empty(graph["commits"]!.AsArray());
        Assert.Empty(graph["branches"]!.AsArray());
        Assert.Empty(graph["remotes"]!.AsArray());
        Assert.False((bool)graph["status"]!["dirty"]!);
    }

    private Task<CommandOutcome> RunAsync(string action, JsonObject fields, DeviceInfo? device = null)
    {
        var control = new CodeJobControl(() => Settings, _host, new FakeProcesses(), _time);
        var processor = new CommandProcessor(new FakePlatform().Services, new ControlState(_time, allow: true, pausedUntil: null), () => Settings, new CommandLog(Path.Combine(_jobs.Root, "log"), _time), null, control);
        var command = new JsonObject { ["type"] = "device.command", ["id"] = Guid.NewGuid().ToString(), ["action"] = action };
        foreach (var (key, value) in fields)
        {
            command[key] = value?.DeepClone();
        }

        return processor.ExecuteAsync(command, device ?? Trusted, CancellationToken.None);
    }

    private static void Refused(CommandOutcome outcome, string message)
    {
        Assert.False(outcome.Ok);
        Assert.Equal(ResultCodes.Refused, outcome.Code);
        Assert.Equal(message, outcome.Error);
    }

    /// <summary>The real git on PATH, run as the app's hosts run it (argument lists, UTF-8 output).</summary>
    private sealed class RealGit(string git) : ICodeHost
    {
        public static string? Find()
        {
            var names = OperatingSystem.IsWindows() ? new[] { "git.exe" } : ["git"];
            return (Environment.GetEnvironmentVariable("PATH") ?? "")
                .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
                .SelectMany(dir => names.Select(n => Path.Combine(dir, n)))
                .FirstOrDefault(File.Exists);
        }

        public static void Run(string git, string dir, params string[] args)
        {
            var result = Start(git, dir, args, new Dictionary<string, string> { ["GIT_CONFIG_NOSYSTEM"] = "1" });
            Assert.True(result.ExitCode == 0, $"git {string.Join(' ', args)}: {result.Stderr}");
        }

        public string? FindOnPath(string program) => program == "git" ? git : null;

        public Task<ToolResult> RunAsync(ToolRun run, TimeSpan timeout, CancellationToken ct) =>
            Task.FromResult(Start(run.FileName, run.WorkingDirectory, run.Arguments, run.Environment));

        public int StartJob(JobLaunch launch) => throw new InvalidOperationException();

        public bool KillTree(int pid) => false;

        private static ToolResult Start(string file, string dir, IEnumerable<string> args, IReadOnlyDictionary<string, string> env)
        {
            var info = new ProcessStartInfo(file)
            {
                WorkingDirectory = dir,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = System.Text.Encoding.UTF8,
                StandardErrorEncoding = System.Text.Encoding.UTF8,
                UseShellExecute = false,
            };
            foreach (var arg in args)
            {
                info.ArgumentList.Add(arg);
            }

            foreach (var (key, value) in env)
            {
                info.Environment[key] = value;
            }

            using var process = Process.Start(info)!;
            var stdout = process.StandardOutput.ReadToEndAsync();
            var stderr = process.StandardError.ReadToEnd();
            process.WaitForExit();
            return new ToolResult(process.ExitCode, stdout.Result, stderr);
        }
    }
}
