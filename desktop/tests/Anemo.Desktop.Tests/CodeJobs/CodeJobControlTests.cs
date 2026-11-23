using System.Text;
using System.Text.Json.Nodes;
using Anemo.Desktop.Core.CodeJobs;
using Anemo.Desktop.Core.Commands;
using Anemo.Desktop.Core.Control;
using Anemo.Desktop.Core.Protocol;
using Anemo.Desktop.Core.Storage;
using Anemo.Desktop.Tests.Fakes;

namespace Anemo.Desktop.Tests.CodeJobs;

/// <summary>code_projects, code_start and code_cancel (device-contracts.md §7.4, code-sessions.md §12.1).</summary>
public sealed class CodeJobControlTests : IDisposable
{
    private static readonly DeviceInfo Trusted = new("dev-1", "Desk PC", "computer", "trusted");
    private static readonly DeviceInfo Watched = new("dev-1", "Desk PC", "computer", "watched");

    private readonly JobsFolder _jobs = new();
    private readonly ManualTime _time = new();
    private readonly FakeProcesses _processes = new();
    private readonly FakeCodeHost _host = FakeCodeHost.WithEverything();
    private readonly ControlState _control;
    private readonly CommandLog _log;
    private readonly CommandProcessor _processor;
    private readonly string _projects;

    public CodeJobControlTests()
    {
        _projects = Path.Combine(_jobs.Root, "projects");
        Directory.CreateDirectory(_projects);
        Settings = new DesktopSettings
        {
            ShareCodeJobs = true,
            StartCodeJobs = true,
            CodeJobsFolder = _jobs.Jobs,
            CodeProjectsFolder = _projects,
            GitHubOwner = "essntl",
        };
        _control = new ControlState(_time, allow: true, pausedUntil: null);
        _log = new CommandLog(Path.Combine(_jobs.Root, "log"), _time);
        var control = new CodeJobControl(() => Settings, _host, _processes, _time, new CodeJobControlOptions { NewIdSuffix = () => "k3x9" });
        _processor = new CommandProcessor(new FakePlatform().Services, _control, () => Settings, _log, null, control);
    }

    private DesktopSettings Settings { get; set; }

    public void Dispose() => _jobs.Dispose();

    // -- refusals ------------------------------------------------------------------------

    [Theory]
    [InlineData("code_projects")]
    [InlineData("code_start")]
    [InlineData("code_cancel")]
    public async Task Every_action_is_refused_on_a_watched_device(string action)
    {
        var outcome = await RunAsync(action, StartFields("anemo"), Watched);

        Refused(outcome, CodeJobControl.NotTrustedMessage);
    }

    [Theory]
    [InlineData("code_projects")]
    [InlineData("code_start")]
    [InlineData("code_cancel")]
    public async Task Every_action_is_refused_while_sharing_is_off(string action)
    {
        Settings = Settings with { ShareCodeJobs = false };

        Refused(await RunAsync(action, StartFields("anemo")), CodeJobControl.ShareOffMessage);
    }

    [Fact]
    public async Task Starting_and_cancelling_need_the_start_setting_listing_doesn_t()
    {
        Settings = Settings with { StartCodeJobs = false };

        Assert.True((await RunAsync("code_projects")).Ok);
        Refused(await RunAsync("code_start", StartFields("anemo")), CodeJobControl.StartOffMessage);
        Refused(await RunAsync("code_cancel", new JsonObject { ["job_id"] = "20261122-100000-abcd" }), CodeJobControl.StartOffMessage);
        Assert.Empty(_host.Started);
    }

    [Fact]
    public async Task Starting_is_refused_while_control_is_paused_cancelling_is_not()
    {
        Directory.CreateDirectory(Path.Combine(_projects, "anemo"));
        _control.Stop();

        var start = await RunAsync("code_start", StartFields("anemo"));

        Assert.False(start.Ok);
        Assert.Equal(ResultCodes.Refused, start.Code);
        Assert.Empty(_host.Started);
        Assert.Equal("There is no job 20261122-100000-abcd.", (await RunAsync("code_cancel", new JsonObject { ["job_id"] = "20261122-100000-abcd" })).Error);
    }

    // -- code_projects -------------------------------------------------------------------

    [Fact]
    public async Task Projects_lists_local_folders_with_their_origin_and_the_owner_s_repositories_not_cloned()
    {
        Repo("anemo-main", "https://github.com/essntl/anemo.git");
        Directory.CreateDirectory(Path.Combine(_projects, "b"));
        Worktree("wt", of: "anemo-main");
        Directory.CreateDirectory(Path.Combine(_projects, ".cache"));
        _host.Answer = _ => new ToolResult(0, """
            [{"name":"anemo","url":"https://github.com/essntl/anemo"},
             {"name":"notes","url":"https://github.com/essntl/notes"},
             {"name":"B","url":"https://github.com/essntl/B"}]
            """, "");

        var outcome = await RunAsync("code_projects");

        Assert.True(outcome.Ok);
        var expected = new JsonObject
        {
            ["projects"] = new JsonArray(
                new JsonObject { ["name"] = "anemo-main", ["dir"] = Path.Combine(_projects, "anemo-main"), ["remote"] = "https://github.com/essntl/anemo.git" },
                new JsonObject { ["name"] = "b", ["dir"] = Path.Combine(_projects, "b"), ["remote"] = null },
                new JsonObject { ["name"] = "wt", ["dir"] = Path.Combine(_projects, "wt"), ["remote"] = "https://github.com/essntl/anemo.git" }),
            ["remote"] = new JsonArray(new JsonObject { ["name"] = "notes", ["url"] = "https://github.com/essntl/notes" }),
            ["note"] = null,
        };
        Assert.Equal(expected.ToJsonString(), outcome.State!.ToJsonString());

        var run = Assert.Single(_host.Runs);
        Assert.Equal(_host.OnPath["gh"], run.FileName);
        Assert.Equal(["repo", "list", "essntl", "--limit", "200", "--json", "name,url"], run.Arguments);
        Assert.Equal("1", run.Environment["GH_PROMPT_DISABLED"]);
        Assert.Equal("0", run.Environment["GIT_TERMINAL_PROMPT"]);
    }

    [Fact]
    public async Task Without_gh_only_local_projects_are_listed_and_the_note_says_why()
    {
        _host.OnPath.TryRemove("gh", out _);
        Directory.CreateDirectory(Path.Combine(_projects, "anemo"));

        var state = (await RunAsync("code_projects")).State!;

        Assert.Single(state["projects"]!.AsArray());
        Assert.Empty(state["remote"]!.AsArray());
        Assert.Equal("GitHub's command line tool (gh) isn't on this computer's PATH, so only local projects are listed.", (string?)state["note"]);
        Assert.Empty(_host.Runs);
    }

    [Fact]
    public async Task A_failing_gh_gives_a_note_not_a_failure()
    {
        _host.Answer = _ => new ToolResult(1, "", "To get started with GitHub CLI, please run: gh auth login");

        var state = (await RunAsync("code_projects")).State!;

        Assert.Empty(state["remote"]!.AsArray());
        Assert.Equal("gh couldn't list the repositories of essntl (is it signed in? gh auth login), so only local projects are listed.", (string?)state["note"]);
    }

    [Fact]
    public async Task A_gh_that_takes_too_long_gives_a_note()
    {
        _host.Answer = _ => throw new TimeoutException();

        var state = (await RunAsync("code_projects")).State!;

        Assert.Equal("gh didn't list the repositories within 30 seconds, so only local projects are listed.", (string?)state["note"]);
    }

    [Fact]
    public async Task Without_an_owner_set_the_repositories_are_those_of_the_account_gh_is_signed_in_as()
    {
        Settings = Settings with { GitHubOwner = null };
        _host.Answer = run => run.Arguments[0] == "api"
            ? new ToolResult(0, "octo-cat\n", "")
            : new ToolResult(0, """[{"name":"notes","url":"https://github.com/octo-cat/notes"}]""", "");

        var state = (await RunAsync("code_projects")).State!;

        var runs = _host.Runs.ToList();
        Assert.Equal(["api", "user", "--jq", ".login"], runs[0].Arguments);
        Assert.Equal(["repo", "list", "octo-cat", "--limit", "200", "--json", "name,url"], runs[1].Arguments);
        Assert.Equal("notes", (string?)state["remote"]![0]!["name"]);
        Assert.Null(state["note"]);
    }

    [Fact]
    public async Task Without_an_owner_and_without_a_signed_in_gh_no_repositories_are_listed()
    {
        Settings = Settings with { GitHubOwner = null };
        _host.Answer = _ => new ToolResult(1, "", "You are not logged into any GitHub hosts. To log in, run: gh auth login");

        var state = (await RunAsync("code_projects")).State!;

        Assert.Empty(state["remote"]!.AsArray());
        Assert.Equal(CodeJobControl.NoOwnerNote, (string?)state["note"]);
        Assert.Single(_host.Runs); // only the question who is signed in
    }

    [Fact]
    public async Task Without_an_owner_and_without_gh_nothing_is_cloned()
    {
        Settings = Settings with { GitHubOwner = null };
        _host.OnPath.TryRemove("gh", out _);

        var outcome = await RunAsync("code_start", StartFields("notes"));

        Assert.StartsWith($"There is no project “notes” in {_projects}, and no GitHub owner is known to clone it from", outcome.Error);
        Assert.Empty(_host.Runs);
        Assert.Empty(_host.Started);
    }

    [Fact]
    public async Task Without_an_owner_a_new_project_is_made_without_trying_a_clone()
    {
        Settings = Settings with { GitHubOwner = null };
        _host.Answer = run => run.Arguments[0] == "api" ? new ToolResult(1, "", "not logged in") : new ToolResult(0, "", "");

        var outcome = await RunAsync("code_start", StartFields("fresh", isNew: true));

        Assert.True(outcome.Ok, outcome.Error);
        Assert.DoesNotContain(_host.Runs, r => r.Arguments.Contains("clone"));
        Assert.Contains(_host.Runs, r => r.Arguments.SequenceEqual(["init"]));
    }

    [Fact]
    public async Task Without_an_owner_set_the_clone_is_from_the_signed_in_account()
    {
        Settings = Settings with { GitHubOwner = null };
        var target = Path.Combine(_projects, "notes");
        _host.Answer = run =>
        {
            if (run.Arguments[0] == "api")
            {
                return new ToolResult(0, "octo-cat\n", "");
            }

            Directory.CreateDirectory(target);
            return new ToolResult(0, "", "");
        };

        Assert.True((await RunAsync("code_start", StartFields("notes"))).Ok);

        Assert.Contains(_host.Runs, r => r.Arguments.SequenceEqual(["repo", "clone", "octo-cat/notes", target]));
    }

    [Fact]
    public async Task A_missing_projects_folder_is_said()
    {
        Directory.Delete(_projects);
        _host.Answer = _ => new ToolResult(0, "[]", "");

        var state = (await RunAsync("code_projects")).State!;

        Assert.Empty(state["projects"]!.AsArray());
        Assert.Equal($"The projects folder {_projects} doesn't exist yet.", (string?)state["note"]);
    }

    // -- code_start: validation ----------------------------------------------------------

    [Theory]
    [InlineData("project", "..")]
    [InlineData("project", ".")]
    [InlineData("project", "a/b")]
    [InlineData("project", "..\\x")]
    [InlineData("project", "my project")]
    [InlineData("project", "x&calc")]
    [InlineData("project", "...")]
    [InlineData("project", "anemo.")]
    [InlineData("project", "CON")]
    [InlineData("project", "nul.txt")]
    [InlineData("project", "Com1")]
    [InlineData("project", "lpt9.md")]
    [InlineData("project", "anemo\n")]
    [InlineData("model", "opus --dangerously")]
    [InlineData("model", "opus&calc")]
    [InlineData("model", "opus\n")]
    [InlineData("resume_session", "abc def")]
    [InlineData("resume_session", "a\"b")]
    [InlineData("resume_session", "abc\n")]
    public async Task Values_that_could_reach_the_command_line_are_checked(string field, string value)
    {
        var fields = StartFields("anemo");
        fields[field] = value;

        var outcome = await RunAsync("code_start", fields);

        Assert.False(outcome.Ok);
        Assert.Equal(ResultCodes.Failed, outcome.Code);
        Assert.StartsWith($"“{field}” must be", outcome.Error);
        Assert.Empty(_host.Started);
        Assert.Empty(Directory.GetDirectories(_jobs.Jobs));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(501)]
    [InlineData(1.5)]
    public async Task Max_turns_is_1_to_500(double turns)
    {
        var fields = StartFields("anemo");
        fields["max_turns"] = turns;

        var outcome = await RunAsync("code_start", fields);

        Assert.Equal("“max_turns” must be a whole number from 1 to 500.", outcome.Error);
    }

    [Fact]
    public async Task The_prompt_is_1_to_100000_characters_and_new_is_a_boolean()
    {
        Assert.Equal("“prompt” is empty.", (await RunAsync("code_start", StartFields("anemo", prompt: ""))).Error);
        Assert.Equal("“prompt” is longer than 100000 characters.", (await RunAsync("code_start", StartFields("anemo", prompt: new string('p', 100_001)))).Error);
        var fields = StartFields("anemo");
        fields["new"] = "yes";
        Assert.Equal("“new” must be true or false.", (await RunAsync("code_start", fields)).Error);
        Assert.Equal("“project” is missing.", (await RunAsync("code_start", new JsonObject { ["prompt"] = "x" })).Error);
        Assert.Empty(_host.Started);
    }

    [Fact]
    public async Task Without_claude_on_PATH_nothing_is_cloned_or_made()
    {
        _host.OnPath.TryRemove("claude", out _);

        var outcome = await RunAsync("code_start", StartFields("notes", isNew: true));

        Assert.Equal(CodeJobControl.NoClaudeMessage, outcome.Error);
        Assert.Empty(_host.Runs);
        Assert.False(Directory.Exists(Path.Combine(_projects, "notes")));
        Assert.Empty(Directory.GetDirectories(_jobs.Jobs));
    }

    // -- code_start: resolution ----------------------------------------------------------

    [Fact]
    public async Task A_folder_of_that_name_comes_first()
    {
        Directory.CreateDirectory(Path.Combine(_projects, "anemo"));
        Repo("anemo-old", "https://github.com/essntl/anemo.git");

        var state = (await RunAsync("code_start", StartFields("anemo"))).State!;

        Assert.Equal(Path.Combine(_projects, "anemo"), (string?)state["dir"]);
        Assert.Equal("anemo", (string?)state["project"]);
        Assert.Empty(_host.Runs);
    }

    [Fact]
    public async Task Else_a_folder_whose_origin_is_that_repository()
    {
        Repo("anemo-main", "git@github.com:essntl/Anemo.git");

        var state = (await RunAsync("code_start", StartFields("anemo"))).State!;

        Assert.Equal(Path.Combine(_projects, "anemo-main"), (string?)state["dir"]);
        Assert.Equal("anemo-main", (string?)state["project"]);
        Assert.Empty(_host.Runs);
    }

    [Fact]
    public async Task Else_it_is_cloned_with_gh()
    {
        var target = Path.Combine(_projects, "notes");
        _host.Answer = run =>
        {
            Directory.CreateDirectory(target);
            return new ToolResult(0, "", "Cloning into 'notes'...");
        };

        var state = (await RunAsync("code_start", StartFields("notes"))).State!;

        var run = Assert.Single(_host.Runs);
        Assert.Equal(_host.OnPath["gh"], run.FileName);
        Assert.Equal(["repo", "clone", "essntl/notes", target], run.Arguments);
        Assert.Equal(_projects, run.WorkingDirectory);
        Assert.Equal(target, (string?)state["dir"]);
        Assert.Single(_host.Started);
    }

    [Fact]
    public async Task Without_gh_it_is_cloned_with_git()
    {
        _host.OnPath.TryRemove("gh", out _);
        var target = Path.Combine(_projects, "notes");
        _host.Answer = run =>
        {
            Directory.CreateDirectory(target);
            return new ToolResult(0, "", "");
        };

        await RunAsync("code_start", StartFields("notes"));

        var run = Assert.Single(_host.Runs);
        Assert.Equal(_host.OnPath["git"], run.FileName);
        Assert.Equal(["clone", "https://github.com/essntl/notes.git", target], run.Arguments);
    }

    [Fact]
    public async Task A_repository_that_doesn_t_exist_with_new_makes_an_empty_repository()
    {
        var target = Path.Combine(_projects, "fresh");
        _host.Answer = run => run.Arguments[0] == "repo"
            ? new ToolResult(1, "", "GraphQL: Could not resolve to a Repository")
            : new ToolResult(0, "Initialized empty Git repository", "");

        var state = (await RunAsync("code_start", StartFields("fresh", isNew: true))).State!;

        Assert.Equal(target, (string?)state["dir"]);
        Assert.True(Directory.Exists(target));
        var init = _host.Runs.Last();
        Assert.Equal(_host.OnPath["git"], init.FileName);
        Assert.Equal(["init"], init.Arguments);
        Assert.Equal(target, init.WorkingDirectory);
    }

    [Fact]
    public async Task No_folder_no_repository_and_not_new_fails_with_the_sentence()
    {
        var target = Path.Combine(_projects, "ghost");
        _host.Answer = _ =>
        {
            Directory.CreateDirectory(target); // a half clone
            return new ToolResult(1, "", "not found");
        };

        var outcome = await RunAsync("code_start", StartFields("ghost"));

        Assert.Equal($"There is no project “ghost” in {_projects} or on GitHub (essntl).", outcome.Error);
        Assert.False(Directory.Exists(target));
        Assert.Empty(_host.Started);
        Assert.Empty(Directory.GetDirectories(_jobs.Jobs));
    }

    [Fact]
    public async Task A_clone_that_takes_more_than_10_minutes_fails()
    {
        _host.Answer = _ => throw new TimeoutException();

        var outcome = await RunAsync("code_start", StartFields("huge", isNew: true));

        Assert.Equal("Cloning essntl/huge took longer than 10 minutes, so it was stopped.", outcome.Error);
        Assert.False(Directory.Exists(Path.Combine(_projects, "huge")));
    }

    [Fact]
    public async Task A_new_project_needs_git()
    {
        _host.OnPath.TryRemove("gh", out _);
        _host.OnPath.TryRemove("git", out _);

        var outcome = await RunAsync("code_start", StartFields("fresh", isNew: true));

        Assert.Equal("git isn't on this computer's PATH, so the new project can't be made.", outcome.Error);
        Assert.False(Directory.Exists(Path.Combine(_projects, "fresh")));
    }

    // -- code_start: the job -------------------------------------------------------------

    [Fact]
    public async Task The_job_folder_is_written_in_cc_ps1_s_format_and_started_detached()
    {
        var dir = Path.Combine(_projects, "anemo");
        Directory.CreateDirectory(dir);
        var prompt = "Fix the flaky test — Grüße ✓\nThen open a PR. " + new string('x', 300);
        var fields = StartFields("anemo", prompt);
        fields["resume_session"] = "4f1c2a9e-0b7d-4e57-9f0a-3c1d2e3f4a5b";
        fields["model"] = "claude-opus-4-1[1m]";
        fields["max_turns"] = 40;

        var outcome = await RunAsync("code_start", fields);

        var local = TimeZoneInfo.ConvertTime(_time.Now, TimeZoneInfo.Local);
        var id = $"{local:yyyyMMdd-HHmmss}-k3x9";
        var folder = Path.Combine(_jobs.Jobs, id);
        Assert.Equal(new JsonObject { ["job_id"] = id, ["dir"] = dir, ["project"] = "anemo" }.ToJsonString(), outcome.State!.ToJsonString());

        Assert.Equal(new UTF8Encoding(false).GetBytes(prompt), File.ReadAllBytes(Path.Combine(folder, "prompt.txt")));
        var meta = JsonNode.Parse(File.ReadAllText(Path.Combine(folder, "meta.json")))!.AsObject();
        Assert.Equal(["id", "pid", "dir", "resume", "started", "prompt_preview", "model"], meta.Select(p => p.Key));
        Assert.Equal(id, (string?)meta["id"]);
        Assert.Equal(9000, (int?)meta["pid"]);
        Assert.Equal(dir, (string?)meta["dir"]);
        Assert.Equal("4f1c2a9e-0b7d-4e57-9f0a-3c1d2e3f4a5b", (string?)meta["resume"]);
        Assert.Equal(local.ToString("yyyy-MM-dd'T'HH:mm:ss.fffffffzzz"), (string?)meta["started"]);
        Assert.Equal(prompt[..200], (string?)meta["prompt_preview"]);
        Assert.Equal("claude-opus-4-1[1m]", (string?)meta["model"]);
        Assert.False(File.Exists(Path.Combine(folder, "meta.json.tmp")));

        var start = Assert.Single(_host.Started);
        Assert.Equal("cmd.exe", start.FileName);
        Assert.Equal(dir, start.WorkingDirectory);
        Assert.Equal(
            "/d /v:off /s /c \"\"C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd\" -p --output-format stream-json --verbose --permission-mode bypassPermissions"
            + " --resume 4f1c2a9e-0b7d-4e57-9f0a-3c1d2e3f4a5b --model claude-opus-4-1[1m] --max-turns 40"
            + $" < \"{folder}{Path.DirectorySeparatorChar}prompt.txt\" > \"{folder}{Path.DirectorySeparatorChar}out.jsonl\" 2> \"{folder}{Path.DirectorySeparatorChar}err.txt\"\"",
            start.CommandLine);
        Assert.Equal("1", start.Environment["NoDefaultCurrentDirectoryInExePath"]);
        Assert.DoesNotContain("Grüße", start.CommandLine); // the prompt only goes through the file
    }

    [Fact]
    public void The_command_line_has_only_the_options_given()
    {
        var folder = Path.Combine("C:", "anemo-bridge", "jobs", "20261122-100000-k3x9");
        const string claude = @"C:\Program Files\nodejs\claude.cmd";
        var redirects = $" < \"{Path.Combine(folder, "prompt.txt")}\" > \"{Path.Combine(folder, "out.jsonl")}\" 2> \"{Path.Combine(folder, "err.txt")}\"";

        Assert.Equal(
            "/d /v:off /s /c \"\"C:\\Program Files\\nodejs\\claude.cmd\" -p --output-format stream-json --verbose --permission-mode bypassPermissions"
            + redirects + "\"",
            CodeJobControl.CommandLine(claude, folder, null, null, null));
        Assert.EndsWith("bypassPermissions --max-turns 7" + redirects + "\"", CodeJobControl.CommandLine(claude, folder, null, null, 7));
    }

    [Fact]
    public async Task A_claude_cmd_in_the_project_folder_is_never_the_one_that_runs()
    {
        // A cloned repository can hold its own claude.cmd; cmd.exe would look in the current folder first.
        var dir = Path.Combine(_projects, "evil");
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, "claude.cmd"), "@echo pwned");

        Assert.True((await RunAsync("code_start", StartFields("evil"))).Ok);

        var start = Assert.Single(_host.Started);
        Assert.Equal(dir, start.WorkingDirectory);
        Assert.StartsWith("/d /v:off /s /c \"\"" + _host.OnPath["claude"] + "\" -p ", start.CommandLine);
        Assert.DoesNotContain(" claude ", start.CommandLine);
        Assert.DoesNotContain(dir, start.CommandLine);
        Assert.Equal("1", start.Environment["NoDefaultCurrentDirectoryInExePath"]);
    }

    [Fact]
    public async Task A_claude_path_a_command_line_can_t_carry_is_refused()
    {
        Directory.CreateDirectory(Path.Combine(_projects, "anemo"));
        _host.OnPath["claude"] = @"C:\100%tools\claude.cmd";

        var outcome = await RunAsync("code_start", StartFields("anemo"));

        Assert.StartsWith("The path of Claude Code (claude) has a \" or % in it", outcome.Error);
        Assert.Empty(_host.Started);
    }

    [Fact]
    public async Task Null_options_are_left_out()
    {
        Directory.CreateDirectory(Path.Combine(_projects, "anemo"));
        var fields = StartFields("anemo");
        fields["resume_session"] = null;
        fields["model"] = null;
        fields["max_turns"] = null;

        Assert.True((await RunAsync("code_start", fields)).Ok);

        var line = Assert.Single(_host.Started).CommandLine;
        Assert.DoesNotContain("--resume", line);
        Assert.DoesNotContain("--model", line);
        Assert.DoesNotContain("--max-turns", line);
        var meta = JsonNode.Parse(File.ReadAllText(Directory.GetFiles(_jobs.Jobs, "meta.json", SearchOption.AllDirectories).Single()))!;
        Assert.Null(meta["resume"]);
        Assert.Null(meta["model"]);
    }

    [Fact]
    public async Task A_job_id_already_taken_gets_another_suffix()
    {
        Directory.CreateDirectory(Path.Combine(_projects, "anemo"));
        var suffixes = new Queue<string>(["aaaa", "aaaa", "bbbb"]);
        var control = new CodeJobControl(() => Settings, _host, _processes, _time, new CodeJobControlOptions { NewIdSuffix = suffixes.Dequeue });
        var processor = new CommandProcessor(new FakePlatform().Services, _control, () => Settings, null, null, control);

        var first = await processor.ExecuteAsync(Command("code_start", StartFields("anemo")), Trusted, CancellationToken.None);
        var second = await processor.ExecuteAsync(Command("code_start", StartFields("anemo")), Trusted, CancellationToken.None);

        Assert.EndsWith("-aaaa", (string?)first.State!["job_id"]);
        Assert.EndsWith("-bbbb", (string?)second.State!["job_id"]);
    }

    [Fact]
    public async Task A_start_Windows_refuses_leaves_no_job_folder()
    {
        Directory.CreateDirectory(Path.Combine(_projects, "anemo"));
        _host.NextPid = null;

        var outcome = await RunAsync("code_start", StartFields("anemo"));

        Assert.Equal("Windows couldn't start the job (Win32Exception).", outcome.Error);
        Assert.Empty(Directory.GetDirectories(_jobs.Jobs));
    }

    [Fact]
    public async Task A_jobs_folder_a_command_line_can_t_carry_is_refused()
    {
        Directory.CreateDirectory(Path.Combine(_projects, "anemo"));
        Settings = Settings with { CodeJobsFolder = Path.Combine(_jobs.Root, "100%jobs") };

        var outcome = await RunAsync("code_start", StartFields("anemo"));

        Assert.StartsWith("The jobs folder's path has a \" or % in it", outcome.Error);
        Assert.Empty(_host.Started);
    }

    [Fact]
    public async Task The_command_log_has_the_job_id_never_the_prompt()
    {
        Directory.CreateDirectory(Path.Combine(_projects, "anemo"));

        var outcome = await RunAsync("code_start", StartFields("anemo", "SECRET-PROMPT do it"));
        await RunAsync("code_cancel", new JsonObject { ["job_id"] = (string?)outcome.State!["job_id"] });

        var lines = _log.Read();
        Assert.Contains(lines, l => (string?)l["action"] == "code_start" && ((string?)l["summary"])!.Contains($"job {outcome.State["job_id"]}"));
        Assert.Contains(lines, l => (string?)l["action"] == "code_cancel");
        Assert.DoesNotContain(lines, l => l.ToJsonString().Contains("SECRET", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_started_job_is_discovered_and_shared_by_the_sharing_loop()
    {
        Directory.CreateDirectory(Path.Combine(_projects, "anemo"));
        var fields = StartFields("anemo", "Add a test for the trimmer.");
        fields["model"] = "sonnet";
        fields["resume_session"] = "sess-0";
        var outcome = await RunAsync("code_start", fields);
        var id = (string)outcome.State!["job_id"]!;
        _processes.Running[9000] = _time.Now; // its cmd.exe runs
        File.WriteAllText(Path.Combine(_jobs.Jobs, id, "out.jsonl"), CodeEvents.Init("sess-1") + "\n");

        var store = new CodeJobStore(_jobs.StateFile, _time, new ListLog());
        var sharing = new SessionHarness(_jobs, _time, _processes, store, new ListLog());
        await sharing.SettleAsync();

        var job = sharing.Server.Jobs[id].Job!;
        Assert.Equal("running", (string?)job["state"]);
        Assert.Equal("Add a test for the trimmer.", (string?)job["prompt"]);
        Assert.Equal(Path.Combine(_projects, "anemo"), (string?)job["dir"]);
        Assert.Equal("anemo", (string?)job["project"]);
        Assert.Equal("sonnet", (string?)job["model"]);
        Assert.Equal("sess-0", (string?)job["resume_session"]);
        Assert.Equal(9000, (int?)job["pid"]);
        Assert.Equal(1, sharing.Server.Jobs[id].LastSeq);
    }

    // -- code_cancel ---------------------------------------------------------------------

    [Fact]
    public async Task Cancelling_a_running_job_ends_its_process_tree_and_writes_the_marker()
    {
        var job = _jobs.Add(_time.Now.AddMinutes(-3), pid: 4321);
        _processes.Running[4321] = job.Started;

        var outcome = await RunAsync("code_cancel", new JsonObject { ["job_id"] = job.Id });

        Assert.Equal(new JsonObject { ["job_id"] = job.Id, ["state"] = "cancelled" }.ToJsonString(), outcome.State!.ToJsonString());
        Assert.Equal([4321], _host.Killed);
        Assert.True(File.Exists(Path.Combine(job.Folder, "cancelled")));
    }

    [Theory]
    [InlineData("done")]
    [InlineData("failed")]
    [InlineData("cancelled")]
    [InlineData("exited_without_result")]
    public async Task Cancelling_a_job_that_ended_answers_its_state(string state)
    {
        var job = _jobs.Add(_time.Now.AddHours(-1), pid: 4321);
        switch (state)
        {
            case "done":
                job.Finish();
                _processes.Running[4321] = job.Started; // still exiting
                break;
            case "failed":
                job.Finish(error: true);
                break;
            case "cancelled":
                job.Cancel();
                break;
        }

        var outcome = await RunAsync("code_cancel", new JsonObject { ["job_id"] = job.Id });

        Assert.Equal(new JsonObject { ["job_id"] = job.Id, ["state"] = state }.ToJsonString(), outcome.State!.ToJsonString());
        Assert.Empty(_host.Killed);
    }

    [Fact]
    public async Task A_pid_that_another_program_got_is_never_killed()
    {
        var job = _jobs.Add(_time.Now.AddHours(-1), pid: 4321);
        _processes.Running[4321] = _time.Now.AddMinutes(-5); // started long after the job

        var outcome = await RunAsync("code_cancel", new JsonObject { ["job_id"] = job.Id });

        Assert.Equal("exited_without_result", (string?)outcome.State!["state"]);
        Assert.Empty(_host.Killed);
        Assert.False(File.Exists(Path.Combine(job.Folder, "cancelled")));
    }

    [Theory]
    [InlineData("20261122-100000-none")]
    [InlineData("..\\..\\Windows")]
    [InlineData("not-a-job")]
    public async Task Cancelling_an_unknown_job_fails(string id)
    {
        var outcome = await RunAsync("code_cancel", new JsonObject { ["job_id"] = id });

        Assert.Equal(ResultCodes.Failed, outcome.Code);
        Assert.Equal($"There is no job {id}.", outcome.Error);
        Assert.Empty(_host.Killed);
    }

    [Fact]
    public async Task A_process_Windows_won_t_end_fails_and_leaves_no_marker()
    {
        var job = _jobs.Add(_time.Now.AddMinutes(-3), pid: 4321);
        _processes.Running[4321] = job.Started;
        _host.KillWorks = false;

        var outcome = await RunAsync("code_cancel", new JsonObject { ["job_id"] = job.Id });

        Assert.Equal("Windows wouldn't end the job's process.", outcome.Error);
        Assert.False(File.Exists(Path.Combine(job.Folder, "cancelled")));
    }

    // -- helpers -------------------------------------------------------------------------

    private Task<CommandOutcome> RunAsync(string action, JsonObject? fields = null, DeviceInfo? device = null) =>
        _processor.ExecuteAsync(Command(action, fields), device ?? Trusted, CancellationToken.None);

    private static JsonObject Command(string action, JsonObject? fields)
    {
        var command = new JsonObject { ["type"] = "device.command", ["id"] = Guid.NewGuid().ToString(), ["action"] = action };
        foreach (var (key, value) in fields ?? new JsonObject())
        {
            command[key] = value?.DeepClone();
        }

        return command;
    }

    private static JsonObject StartFields(string project, string prompt = "Fix the flaky test.", bool isNew = false) => new()
    {
        ["project"] = project,
        ["prompt"] = prompt,
        ["new"] = isNew,
    };

    private static void Refused(CommandOutcome outcome, string message)
    {
        Assert.False(outcome.Ok);
        Assert.Equal(ResultCodes.Refused, outcome.Code);
        Assert.Equal(message, outcome.Error);
    }

    private void Repo(string name, string origin)
    {
        var git = Path.Combine(_projects, name, ".git");
        Directory.CreateDirectory(git);
        File.WriteAllText(Path.Combine(git, "config"), $"""
            [core]
            	repositoryformatversion = 0
            [remote "upstream"]
            	url = https://github.com/someone/else.git
            [remote "origin"]
            	url = {origin}
            	fetch = +refs/heads/*:refs/remotes/origin/*
            [branch "main"]
            	remote = origin
            """);
    }

    private void Worktree(string name, string of)
    {
        var gitDir = Path.Combine(_projects, of, ".git", "worktrees", name);
        Directory.CreateDirectory(gitDir);
        File.WriteAllText(Path.Combine(gitDir, "commondir"), "../..\n");
        Directory.CreateDirectory(Path.Combine(_projects, name));
        File.WriteAllText(Path.Combine(_projects, name, ".git"), $"gitdir: {gitDir}\n");
    }
}
