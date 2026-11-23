namespace Anemo.Desktop.Core.CodeJobs;

/// <summary>The numbers of docs/device-contracts.md §7 and docs/specs/code-sessions.md §4, §6, §9.</summary>
public static class CodeJobLimits
{
    /// <summary>Where <c>cc.ps1</c> puts its jobs, unless Settings says otherwise.</summary>
    public const string DefaultFolder = @"C:\anemo-bridge\jobs";

    /// <summary>Where the projects of <c>code_projects</c> and <c>code_start</c> are, unless Settings says otherwise.</summary>
    public const string DefaultProjectsFolder = @"C:\dev";

    /// <summary>Whose GitHub repositories are listed and cloned, unless Settings says otherwise.</summary>
    public const string DefaultGitHubOwner = "essntl";

    public const int MaxEventsPerFrame = 200;

    /// <summary>256 KB of UTF-8 for a whole <c>code.events</c> text.</summary>
    public const int MaxFrameBytes = 256 * 1024;

    /// <summary>The server ignores a <c>code.job</c> text longer than this (characters).</summary>
    public const int MaxJobMessageChars = 64_000;

    /// <summary>One event, as compact UTF-8 JSON, after trimming (§6).</summary>
    public const int MaxEventBytes = 16_000;

    public const int MaxRawChars = 2000;
    public const int MaxPromptChars = 20_000;
    public const int MaxStderrChars = 4000;
    public const int MaxPathChars = 1000;
    public const int MaxProjectChars = 200;
    public const int MaxSessionChars = 100;
    public const int MaxModelChars = 100;
    public const int MaxBranchChars = 255;

    /// <summary>On the first scan after sharing is switched on, only jobs started this recently.</summary>
    public static readonly TimeSpan BackfillWindow = TimeSpan.FromDays(3);

    /// <summary>Jobs older than this are forgotten by the state file (and not discovered again).</summary>
    public static readonly TimeSpan ForgetAfter = TimeSpan.FromDays(14);

    /// <summary>A process with the job's pid that started later than this after the job is another one.</summary>
    public static readonly TimeSpan PidReuseSlack = TimeSpan.FromMinutes(1);

    /// <summary>A job whose process can't be read counts as running only while it wrote output this recently.</summary>
    public static readonly TimeSpan UnreadableProcessQuietFor = TimeSpan.FromMinutes(30);
}

/// <summary>Timings of the sharing loop; the defaults are the contract's.</summary>
public sealed class CodeJobsOptions
{
    /// <summary>How often the jobs folder is listed.</summary>
    public TimeSpan PollInterval { get; init; } = TimeSpan.FromSeconds(2);

    /// <summary>No <c>code.ack</c> for this long: the connection is dropped and made again.</summary>
    public TimeSpan AckTimeout { get; init; } = TimeSpan.FromSeconds(60);

    /// <summary>
    /// At most this many jobs with a frame in flight at once, so a large back-fill goes out
    /// a few jobs at a time and never holds the connection for long.
    /// </summary>
    public int MaxJobsInFlight { get; init; } = 4;
}
