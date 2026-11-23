using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anemo.Desktop.Core.Commands;
using Anemo.Desktop.Core.Protocol;
using Anemo.Desktop.Core.Storage;

namespace Anemo.Desktop.Core.CodeJobs;

public sealed class CodeJobControlOptions
{
    /// <summary><c>gh repo list</c> gets this long.</summary>
    public TimeSpan ListTimeout { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary>A clone gets this long, then it is stopped.</summary>
    public TimeSpan CloneTimeout { get; init; } = TimeSpan.FromMinutes(10);

    /// <summary><c>git init</c> of a new project gets this long.</summary>
    public TimeSpan InitTimeout { get; init; } = TimeSpan.FromSeconds(60);

    /// <summary>The 4 characters after the time in a new job's id (random by default).</summary>
    public Func<string>? NewIdSuffix { get; init; }
}

/// <summary>
/// The <c>code_projects</c>, <c>code_start</c> and <c>code_cancel</c> actions
/// (device-contracts.md §7.4, code-sessions.md §12.1). A job is started as <c>cc.ps1</c>
/// does it, in the same folder format, so the sharing loop finds it like any other.
/// Programs run only through <see cref="ICodeHost"/>, with arguments made from validated
/// values; the prompt goes through <c>prompt.txt</c>, never the command line.
/// </summary>
public sealed partial class CodeJobControl
{
    public const string NotTrustedMessage = "Claude Code jobs are only for trusted devices, and this one is watched.";
    public const string ShareOffMessage = "Sharing Claude Code jobs is switched off in Anemo Desktop on this computer.";
    public const string StartOffMessage = "Starting Claude Code jobs is switched off in Anemo Desktop on this computer.";
    public const string NoClaudeMessage = "Claude Code (claude) isn't on this computer's PATH.";

    public const string NoOwnerNote =
        "Sign in to GitHub's command line tool (gh auth login) or set a GitHub owner in Anemo Desktop's settings to list the repositories not cloned yet.";

    /// <summary>Set for every gh and git run: never wait for a password or a question.</summary>
    public static readonly IReadOnlyDictionary<string, string> QuietEnvironment = new Dictionary<string, string>
    {
        ["GH_PROMPT_DISABLED"] = "1",
        ["GH_NO_UPDATE_NOTIFIER"] = "1",
        ["GIT_TERMINAL_PROMPT"] = "0",
    };

    /// <summary>A job's cmd.exe never runs a program from the current (project) folder by a bare name.</summary>
    public static readonly IReadOnlyDictionary<string, string> StartEnvironment = new Dictionary<string, string>
    {
        ["NoDefaultCurrentDirectoryInExePath"] = "1",
    };

    private const int PreviewChars = 200;
    private const string IdAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789";

    private readonly Func<DesktopSettings> _settings;
    private readonly ICodeHost _host;
    private readonly IProcessProbe _probe;
    private readonly TimeProvider _time;
    private readonly CodeJobControlOptions _options;

    public CodeJobControl(
        Func<DesktopSettings> settings,
        ICodeHost host,
        IProcessProbe probe,
        TimeProvider time,
        CodeJobControlOptions? options = null)
    {
        _settings = settings;
        _host = host;
        _probe = probe;
        _time = time;
        _options = options ?? new CodeJobControlOptions();
    }

    public static bool Handles(string action) => action is "code_projects" or "code_start" or "code_cancel";

    private string ProjectsFolder => Setting(_settings().CodeProjectsFolder) ?? CodeJobLimits.DefaultProjectsFolder;

    /// <summary>The owner set in Settings, or null when none is.</summary>
    private string? OwnerSetting => Setting(_settings().GitHubOwner);

    private string JobsFolder => Setting(_settings().CodeJobsFolder) ?? CodeJobLimits.DefaultFolder;

    /// <summary>
    /// The command line of a job's <c>cmd.exe</c> (§12.1 step 4, §12.5): Claude Code by the full
    /// path found on PATH, headless, with the prompt on stdin from <c>prompt.txt</c> and its output
    /// and errors into the job folder. <c>/s</c> makes cmd take what is between the outer quotes
    /// as it is; <c>/v:off</c> keeps <c>!</c> literal; <c>/d</c> skips AutoRun.
    /// </summary>
    public static string CommandLine(string claude, string jobFolder, string? resumeSession, string? model, int? maxTurns)
    {
        var line = new StringBuilder(Quote(claude)).Append(" -p --output-format stream-json --verbose --permission-mode bypassPermissions");
        if (resumeSession is not null)
        {
            line.Append(" --resume ").Append(resumeSession);
        }

        if (model is not null)
        {
            line.Append(" --model ").Append(model);
        }

        if (maxTurns is { } turns)
        {
            line.Append(" --max-turns ").Append(turns.ToString(CultureInfo.InvariantCulture));
        }

        line.Append(" < ").Append(Quote(Path.Combine(jobFolder, JobFolder.Prompt)))
            .Append(" > ").Append(Quote(Path.Combine(jobFolder, JobFolder.Out)))
            .Append(" 2> ").Append(Quote(Path.Combine(jobFolder, JobFolder.Err)));
        return "/d /v:off /s /c \"" + line + "\"";
    }

    internal async Task<JsonNode> RunAsync(string action, Args args, DeviceInfo device, CancellationToken ct)
    {
        switch (action)
        {
            case "code_projects":
                RequireShare(device);
                return await ProjectsAsync(ct);
            case "code_start":
                RequireStart(device);
                return await StartAsync(args, ct);
            case "code_cancel":
                RequireStart(device);
                return Cancel(args);
            default:
                throw CommandException.Failed($"Unknown action “{action}”");
        }
    }

    /// <summary>The refusal of §12.1 for <paramref name="action"/>, or null when it may run.</summary>
    public string? RefusalReason(string action, DeviceInfo device)
    {
        var settings = _settings();
        if (!device.Trusted)
        {
            return NotTrustedMessage;
        }

        if (!settings.ShareCodeJobs)
        {
            return ShareOffMessage;
        }

        return action != "code_projects" && !settings.StartCodeJobs ? StartOffMessage : null;
    }

    private void RequireShare(DeviceInfo device)
    {
        if (RefusalReason("code_projects", device) is { } reason)
        {
            throw CommandException.Refused(reason);
        }
    }

    private void RequireStart(DeviceInfo device)
    {
        if (RefusalReason("code_start", device) is { } reason)
        {
            throw CommandException.Refused(reason);
        }
    }

    // -- code_projects -------------------------------------------------------------------

    private async Task<JsonNode> ProjectsAsync(CancellationToken ct)
    {
        var folder = ProjectsFolder;
        var local = CodeProjects.Local(folder);
        var (remote, note) = await RemoteAsync(folder, ct);
        if (note is null && !Directory.Exists(folder))
        {
            note = $"The projects folder {folder} doesn't exist yet.";
        }

        var projects = new JsonArray();
        foreach (var p in local)
        {
            projects.Add(new JsonObject { ["name"] = p.Name, ["dir"] = p.Dir, ["remote"] = p.Remote });
        }

        var remoteList = new JsonArray();
        foreach (var r in remote.Where(r => !CodeProjects.HasLocal(local, r.Name)).OrderBy(r => r.Name, StringComparer.OrdinalIgnoreCase))
        {
            remoteList.Add(new JsonObject { ["name"] = r.Name, ["url"] = r.Url });
        }

        return new JsonObject { ["projects"] = projects, ["remote"] = remoteList, ["note"] = note };
    }

    /// <summary>The owner's repositories (gh repo list), or none and a sentence why.</summary>
    private async Task<(IReadOnlyList<RemoteProject> Remote, string? Note)> RemoteAsync(string folder, CancellationToken ct)
    {
        if (OwnerSetting is { } set && !CodeProjects.IsOwner(set))
        {
            return ([], "The GitHub owner in Anemo Desktop's settings isn't a valid GitHub name, so only local projects are listed.");
        }

        if (Tool("gh") is not { } gh)
        {
            return ([], "GitHub's command line tool (gh) isn't on this computer's PATH, so only local projects are listed.");
        }

        if (await OwnerAsync(ct) is not { } owner)
        {
            return ([], NoOwnerNote);
        }

        ToolResult result;
        try
        {
            result = await _host.RunAsync(
                new ToolRun(gh, ["repo", "list", owner, "--limit", "200", "--json", "name,url"], WorkingFolder(folder), QuietEnvironment),
                _options.ListTimeout,
                ct);
        }
        catch (TimeoutException)
        {
            return ([], $"gh didn't list the repositories within {_options.ListTimeout.TotalSeconds:0} seconds, so only local projects are listed.");
        }

        if (result.ExitCode != 0)
        {
            return ([], $"gh couldn't list the repositories of {owner} (is it signed in? gh auth login), so only local projects are listed.");
        }

        return CodeProjects.ParseRepoList(result.Stdout) is { } list
            ? (list, null)
            : ([], "gh's list of repositories couldn't be read, so only local projects are listed.");
    }

    // -- code_start ----------------------------------------------------------------------

    private async Task<JsonNode> StartAsync(Args args, CancellationToken ct)
    {
        // 1. Validate. A follow-up names its earlier job and runs in its folder: project is ignored.
        var follow = args.OptionalString("follow_job_id");
        if (follow is not null && !JobFolder.IsJobId(follow))
        {
            throw CommandException.Failed("“follow_job_id” must be a job id like 20261123-101500-ab12.");
        }

        var project = follow is null ? args.String("project", CodeJobLimits.MaxProjectChars) : null;
        if (project is not null && !CodeProjects.IsProjectName(project))
        {
            throw CommandException.Failed(
                "“project” must be a folder name of at most 100 letters, digits, dots, dashes and underscores (not only dots, not ending with a dot, not a Windows device name).");
        }

        var prompt = args.String("prompt", 100_000);
        var isNew = args.Bool("new", false);
        var resume = Optional(args, "resume_session", SessionPattern(), "“resume_session” must be a Claude Code session id (letters, digits and dashes).");
        var model = Optional(args, "model", ModelPattern(), "“model” must be a model name of at most 100 letters, digits, dots, dashes, underscores and brackets.");
        int? maxTurns = args.Has("max_turns") ? args.Int("max_turns", 1, 500) : null;

        // The full path, so a claude.cmd in the project folder (a cloned repository's) never runs.
        var claude = _host.FindOnPath("claude") ?? throw CommandException.Failed(NoClaudeMessage);
        if (!CommandLineSafe(claude))
        {
            throw CommandException.Failed("The path of Claude Code (claude) has a \" or % in it, which a command line can't carry.");
        }

        var jobs = JobsFolder;
        if (!CommandLineSafe(jobs))
        {
            throw CommandException.Failed("The jobs folder's path has a \" or % in it, which a command line can't carry; choose another one in Anemo Desktop's settings.");
        }

        // 2. Resolve the project (a follow-up never clones or makes one).
        var dir = follow is not null ? FollowedFolder(jobs, follow) : await ResolveAsync(project!, isNew, ct);

        // 3. The job folder and its prompt.
        var started = _time.GetLocalNow();
        var (id, folder) = NewJobFolder(jobs, started);
        File.WriteAllText(Path.Combine(folder, JobFolder.Prompt), prompt, new UTF8Encoding(false));

        // 4. Start, then meta.json with the pid: the sharing loop takes the folder only once
        // meta.json reads, so it never sees the job without its process.
        int pid;
        try
        {
            pid = _host.StartDetached(new DetachedStart("cmd.exe", CommandLine(claude, folder, resume, model, maxTurns), dir, StartEnvironment));
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            TryDelete(folder);
            throw CommandException.Failed($"Windows couldn't start the job ({e.GetType().Name}).");
        }

        WriteMeta(folder, new JsonObject
        {
            ["id"] = id,
            ["pid"] = pid,
            ["dir"] = dir,
            ["resume"] = resume,
            ["started"] = started.ToString("yyyy-MM-dd'T'HH:mm:ss.fffffffzzz", CultureInfo.InvariantCulture),
            ["prompt_preview"] = JobFolder.Cut(prompt, PreviewChars),
            ["model"] = model,
        });

        // 5. The answer; code.job follows from the sharing loop's next scan.
        return new JsonObject { ["job_id"] = id, ["dir"] = dir, ["project"] = Path.GetFileName(dir) };
    }

    /// <summary>
    /// The project's folder: <c>&lt;projects&gt;\&lt;project&gt;</c>; else a folder whose origin
    /// is that repository; else a clone from GitHub; else, with <paramref name="isNew"/>, a new
    /// folder with <c>git init</c>.
    /// </summary>
    private async Task<string> ResolveAsync(string project, bool isNew, CancellationToken ct)
    {
        var projects = ProjectsFolder;
        var target = Path.Combine(projects, project);
        if (Directory.Exists(target))
        {
            return target;
        }

        var byRemote = CodeProjects.Local(projects)
            .FirstOrDefault(p => string.Equals(CodeProjects.RepositoryName(p.Remote), project, StringComparison.OrdinalIgnoreCase));
        if (byRemote is not null)
        {
            return byRemote.Dir;
        }

        var owner = await OwnerAsync(ct);
        if (owner is not null && await CloneAsync(owner, project, projects, target, ct))
        {
            return target;
        }

        if (isNew)
        {
            return await CreateAsync(target, ct);
        }

        throw CommandException.Failed(owner is null
            ? $"There is no project “{project}” in {projects}, and no GitHub owner is known to clone it from (sign in to gh with gh auth login, or set an owner in Anemo Desktop's settings)."
            : $"There is no project “{project}” in {projects} or on GitHub ({owner}).");
    }

    /// <summary>The folder recorded in the earlier job's <c>meta.json</c> (§12.5 follow-ups).</summary>
    private static string FollowedFolder(string jobs, string follow)
    {
        var earlier = Path.Combine(jobs, follow);
        if (!Directory.Exists(earlier))
        {
            throw CommandException.Failed($"There is no job {follow}.");
        }

        if (JobFolder.ReadMeta(earlier, follow) is not { Dir: { Length: > 0 } dir } || !Directory.Exists(dir))
        {
            throw CommandException.Failed($"The folder of job {follow} is gone.");
        }

        return dir;
    }

    /// <summary>
    /// The GitHub owner: the one set in Settings, else the account gh is signed in as
    /// (<c>gh api user --jq .login</c>, 30 s); null when neither is known (§12.5).
    /// </summary>
    private async Task<string?> OwnerAsync(CancellationToken ct)
    {
        if (OwnerSetting is { } set)
        {
            return CodeProjects.IsOwner(set) ? set : null;
        }

        if (Tool("gh") is not { } gh)
        {
            return null;
        }

        try
        {
            var result = await _host.RunAsync(
                new ToolRun(gh, ["api", "user", "--jq", ".login"], Path.GetTempPath(), QuietEnvironment), _options.ListTimeout, ct);
            var login = result.Stdout.Trim();
            return result.ExitCode == 0 && CodeProjects.IsOwner(login) ? login : null;
        }
        catch (TimeoutException)
        {
            return null;
        }
    }

    /// <summary>True when the clone made the folder; false when there is no such repository (or no gh/git).</summary>
    private async Task<bool> CloneAsync(string owner, string project, string projects, string target, CancellationToken ct)
    {
        ToolRun run;
        if (Tool("gh") is { } gh)
        {
            run = new ToolRun(gh, ["repo", "clone", $"{owner}/{project}", target], projects, QuietEnvironment);
        }
        else if (Tool("git") is { } git)
        {
            run = new ToolRun(git, ["clone", $"https://github.com/{owner}/{project}.git", target], projects, QuietEnvironment);
        }
        else
        {
            return false;
        }

        Directory.CreateDirectory(projects);
        var done = false;
        try
        {
            var result = await _host.RunAsync(run, _options.CloneTimeout, ct);
            done = result.ExitCode == 0 && Directory.Exists(target);
            return done;
        }
        catch (TimeoutException)
        {
            throw CommandException.Failed(
                $"Cloning {owner}/{project} took longer than {_options.CloneTimeout.TotalMinutes:0} minutes, so it was stopped.");
        }
        finally
        {
            if (!done)
            {
                TryDelete(target); // a half clone (the folder didn't exist before)
            }
        }
    }

    private async Task<string> CreateAsync(string target, CancellationToken ct)
    {
        if (Tool("git") is not { } git)
        {
            throw CommandException.Failed("git isn't on this computer's PATH, so the new project can't be made.");
        }

        Directory.CreateDirectory(target);
        ToolResult result;
        try
        {
            result = await _host.RunAsync(new ToolRun(git, ["init"], target, QuietEnvironment), _options.InitTimeout, ct);
        }
        catch (TimeoutException)
        {
            result = new ToolResult(-1, "", "");
        }

        if (result.ExitCode != 0)
        {
            TryDelete(target);
            throw CommandException.Failed($"git init failed in {target}, so the new project wasn't made.");
        }

        return target;
    }

    /// <summary>A new folder <c>&lt;jobs&gt;\yyyyMMdd-HHmmss-xxxx</c> (local time, 4 random lowercase letters or digits).</summary>
    private (string Id, string Folder) NewJobFolder(string jobs, DateTimeOffset started)
    {
        Directory.CreateDirectory(jobs);
        for (var attempt = 0; attempt < 50; attempt++)
        {
            var id = $"{started.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture)}-{_options.NewIdSuffix?.Invoke() ?? RandomSuffix()}";
            var folder = Path.Combine(jobs, id);
            if (JobFolder.IsJobId(id) && !Directory.Exists(folder))
            {
                Directory.CreateDirectory(folder);
                return (id, folder);
            }
        }

        throw CommandException.Failed("No new job folder could be made in the jobs folder.");
    }

    private static void WriteMeta(string folder, JsonObject meta)
    {
        var path = Path.Combine(folder, JobFolder.Meta);
        var temp = path + ".tmp";
        File.WriteAllText(temp, Wire.Json(meta), new UTF8Encoding(false));
        File.Move(temp, path, overwrite: true);
    }

    // -- code_cancel ---------------------------------------------------------------------

    private JsonNode Cancel(Args args)
    {
        var id = args.String("job_id", 100);
        var folder = Path.Combine(JobsFolder, id);
        if (!JobFolder.IsJobId(id) || !Directory.Exists(folder))
        {
            throw CommandException.Failed($"There is no job {JobFolder.Cut(id, 40)}.");
        }

        if (JobFolder.ReadMeta(folder, id) is not { } meta)
        {
            throw CommandException.Failed($"The job {id} has no readable meta.json, so its process isn't known.");
        }

        var state = JobState.Read(folder, meta, _probe, _time.GetUtcNow());
        if (JobStates.IsTerminal(state))
        {
            return new JsonObject { ["job_id"] = id, ["state"] = state };
        }

        // The marker first: the sharing loop must never see the process gone without it
        // (that would be "exited without result", which notifies).
        var marker = Path.Combine(folder, JobFolder.Cancelled);
        File.WriteAllText(marker, "");
        if (!_host.KillTree(meta.Pid!.Value))
        {
            TryDeleteFile(marker);
            throw CommandException.Failed("Windows wouldn't end the job's process.");
        }

        return new JsonObject { ["job_id"] = id, ["state"] = JobStates.Cancelled };
    }

    // -- helpers -------------------------------------------------------------------------

    private static string? Optional(Args args, string key, Regex pattern, string message)
    {
        var value = args.OptionalString(key);
        if (value is null)
        {
            return null;
        }

        return pattern.IsMatch(value) ? value : throw CommandException.Failed(message);
    }

    private static string? Setting(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    /// <summary>
    /// gh or git as found on PATH, but never a .cmd or .bat: Windows runs those through
    /// cmd.exe, which would read %, &amp; and quotes in the arguments (a folder from Settings) its
    /// own way. Such a gh or git counts as missing.
    /// </summary>
    private string? Tool(string name) =>
        _host.FindOnPath(name) is { } path && Path.GetExtension(path).ToLowerInvariant() is not (".cmd" or ".bat") ? path : null;

    private static string WorkingFolder(string folder) => Directory.Exists(folder) ? folder : Path.GetTempPath();

    private static string Quote(string path) => "\"" + path + "\"";

    /// <summary>A path cmd.exe takes literally inside quotes: no quote, no %, no line break.</summary>
    private static bool CommandLineSafe(string path) => path.IndexOfAny(['"', '%', '\r', '\n']) < 0;

    private static string RandomSuffix() =>
        string.Create(4, 0, (span, _) =>
        {
            for (var i = 0; i < span.Length; i++)
            {
                span[i] = IdAlphabet[RandomNumberGenerator.GetInt32(IdAlphabet.Length)];
            }
        });

    private static void TryDelete(string folder)
    {
        try
        {
            if (Directory.Exists(folder))
            {
                Directory.Delete(folder, recursive: true);
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // Left for the user; it holds nothing secret.
        }
    }

    private static void TryDeleteFile(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
    }

    [GeneratedRegex(@"^[A-Za-z0-9-]{1,100}\z")]
    private static partial Regex SessionPattern();

    [GeneratedRegex(@"^[A-Za-z0-9._\[\]-]{1,100}\z")]
    private static partial Regex ModelPattern();
}
