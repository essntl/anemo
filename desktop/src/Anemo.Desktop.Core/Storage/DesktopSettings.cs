using Anemo.Desktop.Core.Control;

namespace Anemo.Desktop.Core.Storage;

/// <summary>
/// What <c>%APPDATA%\Anemo Desktop\settings.json</c> holds. The token is only kept
/// protected (DPAPI, current user), never in clear.
/// </summary>
public sealed record DesktopSettings
{
    /// <summary>The address the web app uses, e.g. <c>https://anemo.example.com</c>.</summary>
    public string? Address { get; init; }

    /// <summary>The device token, protected with <see cref="Platform.ITokenProtector"/>.</summary>
    public string? ProtectedToken { get; init; }

    /// <summary>"Allow control": the agent may act (click, type, …) on this computer.</summary>
    public bool AllowControl { get; init; } = true;

    /// <summary>PowerShell is switched on in the client (and only used on a trusted device).</summary>
    public bool PowerShellEnabled { get; init; }

    /// <summary>The folder PowerShell starts in; null means <c>%USERPROFILE%\AnemoWork</c>.</summary>
    public string? WorkFolder { get; init; }

    public string StopHotkey { get; init; } = Hotkey.DefaultStop;

    public string ShareHotkey { get; init; } = Hotkey.DefaultShare;

    /// <summary>Control is paused until then (the stop hotkey, "Pause control for 1 hour").</summary>
    public DateTimeOffset? PausedUntil { get; init; }

    /// <summary>A shortcut in the user's Startup folder.</summary>
    public bool StartWithWindows { get; init; } = true;

    /// <summary>
    /// "Share Claude Code jobs with Anemo": the jobs' prompts, tool calls and output go to
    /// Anemo while the device is trusted there (code-sessions.md D4). Off by default.
    /// </summary>
    public bool ShareCodeJobs { get; init; }

    /// <summary>The Claude Code jobs folder; null means <c>C:\anemo-bridge\jobs</c>.</summary>
    public string? CodeJobsFolder { get; init; }
}
