namespace Anemo.Desktop.Core.CodeJobs;

/// <summary>A program run to its end with its output read (<c>gh</c>, <c>git</c>); never through a shell.</summary>
/// <param name="FileName">The program, as found on PATH.</param>
/// <param name="Arguments">Each argument as it is; the platform quotes them.</param>
/// <param name="Environment">Variables set for this run only (e.g. no credential prompts).</param>
public sealed record ToolRun(
    string FileName,
    IReadOnlyList<string> Arguments,
    string WorkingDirectory,
    IReadOnlyDictionary<string, string> Environment);

public sealed record ToolResult(int ExitCode, string Stdout, string Stderr);

/// <summary>
/// A Claude Code job's start on Windows: <c>cmd.exe</c> with this raw command line (it holds
/// the redirections), in the project folder, detached and without a window, outliving Anemo
/// Desktop. Made from a <see cref="JobLaunch"/> by <see cref="WindowsJobCommand"/>.
/// </summary>
/// <param name="Environment">Variables set for it on top of the client's own.</param>
public sealed record DetachedStart(
    string FileName,
    string CommandLine,
    string WorkingDirectory,
    IReadOnlyDictionary<string, string> Environment);

/// <summary>
/// A Claude Code job to start, the same on every system: Claude Code (its full path) with
/// <see cref="Arguments"/>, its stdin from <c>prompt.txt</c>, its stdout and stderr into
/// <c>out.jsonl</c> and <c>err.txt</c> of <paramref name="JobFolder"/>, in the project folder
/// <paramref name="WorkingDirectory"/>, detached, outliving Anemo Desktop
/// (device-contracts.md §7.4). Each host starts it its own way.
/// </summary>
public sealed record JobLaunch(
    string Claude,
    string JobFolder,
    string WorkingDirectory,
    string? Resume,
    string? Model,
    int? MaxTurns,
    string? Feeder = null)
{
    /// <summary>
    /// The job takes messages while it runs (§15): its stdin comes from
    /// <see cref="JobFeeder"/>'s script, run by <see cref="Feeder"/> (Windows PowerShell), instead
    /// of <c>prompt.txt</c>.
    /// </summary>
    public bool Input => Feeder is not null;

    /// <summary><c>claude</c>'s arguments, each as it is (no quoting).</summary>
    public IReadOnlyList<string> Arguments
    {
        get
        {
            var args = new List<string> { "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions" };
            if (Resume is not null)
            {
                args.AddRange(["--resume", Resume]);
            }

            if (Model is not null)
            {
                args.AddRange(["--model", Model]);
            }

            if (MaxTurns is { } turns)
            {
                args.AddRange(["--max-turns", turns.ToString(System.Globalization.CultureInfo.InvariantCulture)]);
            }

            return args;
        }
    }

    public string PromptPath => System.IO.Path.Combine(JobFolder, CodeJobs.JobFolder.Prompt);

    public string OutPath => System.IO.Path.Combine(JobFolder, CodeJobs.JobFolder.Out);

    public string ErrPath => System.IO.Path.Combine(JobFolder, CodeJobs.JobFolder.Err);
}

/// <summary>How Windows starts a <see cref="JobLaunch"/>: through <c>cmd.exe</c>, as <c>cc.ps1</c> does.</summary>
public static class WindowsJobCommand
{
    public static DetachedStart For(JobLaunch launch) => new(
        "cmd.exe",
        launch.Feeder is { } feeder
            ? JobFeeder.CommandLine(feeder, launch.Claude, launch.JobFolder, launch.Resume, launch.Model, launch.MaxTurns)
            : CodeJobControl.CommandLine(launch.Claude, launch.JobFolder, launch.Resume, launch.Model, launch.MaxTurns),
        launch.WorkingDirectory,
        CodeJobControl.StartEnvironment);
}

/// <summary>The processes the <c>code_*</c> actions need (System.Diagnostics.Process in the app).</summary>
public interface ICodeHost
{
    /// <summary>The full path of a program on PATH (with PATHEXT, as <c>where</c> finds it), or null.</summary>
    string? FindOnPath(string program);

    /// <summary>
    /// Runs the program to its end. When <paramref name="timeout"/> passes, or the token is
    /// cancelled, its process tree is ended and <see cref="TimeoutException"/> or
    /// <see cref="OperationCanceledException"/> is thrown.
    /// </summary>
    Task<ToolResult> RunAsync(ToolRun run, TimeSpan timeout, CancellationToken ct);

    /// <summary>
    /// Starts the job detached; returns the pid of its process (Windows: the <c>cmd.exe</c> of
    /// <see cref="WindowsJobCommand"/>; macOS: Claude Code itself, leading its own process group).
    /// </summary>
    int StartJob(JobLaunch launch);

    /// <summary>Ends the process and every process it started; false when Windows wouldn't.</summary>
    bool KillTree(int pid);

    /// <summary>
    /// Windows PowerShell from the system folder (never one found on PATH or in a project
    /// folder), which feeds the messages of a job that takes them (§15); null when it isn't there.
    /// </summary>
    string? WindowsPowerShell()
    {
        var path = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
        return File.Exists(path) ? path : null;
    }
}

/// <summary>No programs at all (where no host is given): every lookup finds nothing.</summary>
public sealed class NoCodeHost : ICodeHost
{
    public static readonly NoCodeHost Instance = new();

    public string? FindOnPath(string program) => null;

    public Task<ToolResult> RunAsync(ToolRun run, TimeSpan timeout, CancellationToken ct) =>
        throw new InvalidOperationException("No programs can be run here.");

    public int StartJob(JobLaunch launch) => throw new InvalidOperationException("No programs can be run here.");

    public bool KillTree(int pid) => false;
}
