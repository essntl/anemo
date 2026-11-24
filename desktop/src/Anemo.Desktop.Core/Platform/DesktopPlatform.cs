using Anemo.Desktop.Core.CodeJobs;

namespace Anemo.Desktop.Core.Platform;

/// <summary>
/// What differs between the operating systems Anemo Desktop runs on, as plain data, so the
/// rules in Core stay the same for every one of them (docs/specs/09-desktop-macos.md §5).
/// <see cref="Windows"/> holds what the Windows client always did.
/// </summary>
public sealed record DesktopPlatform
{
    /// <summary><c>hello.platform</c> (device-contracts.md §2): <c>windows</c> or <c>macos</c>.</summary>
    public required string WireName { get; init; }

    /// <summary>The system's name in sentences: "Windows couldn't start the job".</summary>
    public required string DisplayName { get; init; }

    /// <summary>The shell's name at the start of a sentence: "PowerShell is switched off …".</summary>
    public required string ShellName { get; init; }

    /// <summary>The answer when no shell program is found.</summary>
    public required string NoShellMessage { get; init; }

    /// <summary>The answer while the system shows a screen no program may use (UAC, the lock screen).</summary>
    public required string SecureScreenMessage { get; init; }

    /// <summary>The Claude Code jobs folder when Settings names none.</summary>
    public required string DefaultJobsFolder { get; init; }

    /// <summary>The projects folder when Settings names none.</summary>
    public required string DefaultProjectsFolder { get; init; }

    /// <summary>
    /// A job's command line goes through <c>cmd.exe</c>, so the paths in it must not hold a
    /// quote or %. (On macOS a job is started without any shell.)
    /// </summary>
    public bool JobsThroughCmdExe { get; init; }

    /// <summary><c>press</c> takes <c>Cmd</c> as a modifier and the Mac's own keys rules apply.</summary>
    public bool IsMac { get; init; }

    public static DesktopPlatform Windows { get; } = new()
    {
        WireName = "windows",
        DisplayName = "Windows",
        ShellName = "PowerShell",
        NoShellMessage = "PowerShell wasn't found on this computer.",
        SecureScreenMessage = Commands.CommandProcessor.SecureDesktopMessage,
        DefaultJobsFolder = CodeJobLimits.DefaultFolder,
        DefaultProjectsFolder = CodeJobLimits.DefaultProjectsFolder,
        JobsThroughCmdExe = true,
    };

    /// <summary>macOS, for the user whose home folder is <paramref name="home"/>.</summary>
    public static DesktopPlatform MacOS(string home) => new()
    {
        WireName = "macos",
        DisplayName = "macOS",
        ShellName = "The shell",
        NoShellMessage = "Neither zsh nor bash was found on this Mac.",
        SecureScreenMessage =
            "The Mac is locked, or System Settings or a permission or password prompt is in front: Anemo Desktop doesn't look at or act on those. Ask the user to deal with it first.",
        // Joined with "/" whatever system the tests run on: these are macOS paths.
        DefaultJobsFolder = home.TrimEnd('/') + "/anemo-bridge/jobs",
        DefaultProjectsFolder = home.TrimEnd('/') + "/dev",
        IsMac = true,
    };
}
