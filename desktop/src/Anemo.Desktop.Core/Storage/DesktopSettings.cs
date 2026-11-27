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

    /// <summary>
    /// "Let Anemo start Claude Code jobs" (code-sessions.md D14, §12.1): <c>code_start</c> and
    /// <c>code_cancel</c>. The jobs run with <c>--permission-mode bypassPermissions</c>. Only
    /// counts while <see cref="ShareCodeJobs"/> is on (a job Anemo starts must be visible to it).
    /// </summary>
    public bool StartCodeJobs { get; init; }

    /// <summary>Where the projects are; null means <c>C:\dev</c>.</summary>
    public string? CodeProjectsFolder { get; init; }

    /// <summary>Whose GitHub repositories are listed and cloned; null means the account gh is signed in as.</summary>
    public string? GitHubOwner { get; init; }

    /// <summary>
    /// "Let Anemo read and write files" (device-contracts.md §8, 1.7.0): Anemo's agents copy
    /// files between this computer and the workspace, only while the device is trusted. Off by default.
    /// </summary>
    public bool ShareFiles { get; init; }

    /// <summary>The folders those files may be in; null or empty means the user's home folder (hidden and system folders never).</summary>
    public IReadOnlyList<string>? FileFolders { get; init; }

    /// <summary>
    /// "Update automatically" (docs/specs/23-desktop-auto-update.md, 1.8.0): check GitHub Releases
    /// at start and every 6 hours, download a new version and install it at quit. On by default.
    /// </summary>
    public bool AutoUpdate { get; init; } = true;

    /// <summary>
    /// "Confirm loosened permissions on this computer" (docs/specs/25-device-permission-profiles.md
    /// §10, 1.10.0): a permission change from Anemo that loosens anything waits for a click here.
    /// Only switched in this window, never by the server. Off by default.
    /// </summary>
    public bool ConfirmLoosenedPermissions { get; init; }
}
