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
/// A Claude Code job's start: <c>cmd.exe</c> with this raw command line (it holds the
/// redirections), in the project folder, detached and without a window, outliving Anemo Desktop.
/// </summary>
public sealed record DetachedStart(string FileName, string CommandLine, string WorkingDirectory);

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

    /// <summary>Starts it detached; returns the pid of <c>cmd.exe</c>.</summary>
    int StartDetached(DetachedStart start);

    /// <summary>Ends the process and every process it started; false when Windows wouldn't.</summary>
    bool KillTree(int pid);
}

/// <summary>No programs at all (where no host is given): every lookup finds nothing.</summary>
public sealed class NoCodeHost : ICodeHost
{
    public static readonly NoCodeHost Instance = new();

    public string? FindOnPath(string program) => null;

    public Task<ToolResult> RunAsync(ToolRun run, TimeSpan timeout, CancellationToken ct) =>
        throw new InvalidOperationException("No programs can be run here.");

    public int StartDetached(DetachedStart start) => throw new InvalidOperationException("No programs can be run here.");

    public bool KillTree(int pid) => false;
}
