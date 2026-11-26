using Anemo.Desktop.Core.CodeJobs;
using Anemo.Desktop.Core.Connection;
using Anemo.Desktop.Core.Control;

namespace Anemo.Desktop.Core.Storage;

/// <summary>The fields of the Settings window, for pointing at the one with a problem.</summary>
public enum SettingsField
{
    Address,
    Token,
    StopKey,
    ShareKey,
    GitHubOwner,
    FileFolders,
}

/// <summary>Why the settings can't be saved, and which field to fix.</summary>
public sealed record SettingsProblem(SettingsField Field, string Message);

/// <summary>The result of <see cref="SettingsDraft.Check"/>: the settings and new token to save, or a problem.</summary>
public sealed record SettingsCheck(DesktopSettings? Settings, string? NewToken, SettingsProblem? Problem)
{
    public bool Ok => Problem is null;
}

/// <summary>
/// What the Settings window holds before Save, as typed. The token field is empty unless the
/// user pastes a new one: a saved token is never shown again.
/// </summary>
public sealed record SettingsDraft
{
    public string Address { get; init; } = "";

    public string Token { get; init; } = "";

    public bool PowerShellEnabled { get; init; }

    public string WorkFolder { get; init; } = "";

    public string StopHotkey { get; init; } = Hotkey.DefaultStop;

    public string ShareHotkey { get; init; } = Hotkey.DefaultShare;

    public bool StartWithWindows { get; init; }

    public bool ShareCodeJobs { get; init; }

    public string CodeJobsFolder { get; init; } = "";

    public bool StartCodeJobs { get; init; }

    public string CodeProjectsFolder { get; init; } = "";

    public string GitHubOwner { get; init; } = "";

    public bool ShareFiles { get; init; }

    /// <summary>The allowed folders, separated by <c>;</c> (or one per line); empty: the home folder.</summary>
    public string FileFolders { get; init; } = "";

    public static SettingsDraft From(DesktopSettings settings) => new()
    {
        Address = settings.Address ?? "",
        PowerShellEnabled = settings.PowerShellEnabled,
        WorkFolder = settings.WorkFolder ?? "",
        StopHotkey = settings.StopHotkey,
        ShareHotkey = settings.ShareHotkey,
        StartWithWindows = settings.StartWithWindows,
        ShareCodeJobs = settings.ShareCodeJobs,
        CodeJobsFolder = settings.CodeJobsFolder ?? "",
        StartCodeJobs = settings.StartCodeJobs,
        CodeProjectsFolder = settings.CodeProjectsFolder ?? "",
        GitHubOwner = settings.GitHubOwner ?? "",
        ShareFiles = settings.ShareFiles,
        FileFolders = string.Join("; ", settings.FileFolders ?? []),
    };

    /// <summary>
    /// Checks the fields in the window's order and gives the settings to save on top of
    /// <paramref name="current"/> (which keeps what the window doesn't show, such as the pause).
    /// </summary>
    public SettingsCheck Check(DesktopSettings current)
    {
        var address = AnemoAddress.Parse(Address);
        if (address is null)
        {
            return Fail(SettingsField.Address, "The address must start with https:// (plain http only for this computer).");
        }

        var token = Token.Trim();
        if (token.Length > 0 && !token.StartsWith("anemo_", StringComparison.Ordinal))
        {
            return Fail(SettingsField.Token, "A device token starts with anemo_.");
        }

        var stop = Hotkey.Parse(StopHotkey);
        var share = Hotkey.Parse(ShareHotkey);
        if (stop is null || share is null)
        {
            return Fail(
                stop is null ? SettingsField.StopKey : SettingsField.ShareKey,
                "Keys look like Ctrl+Alt+Shift+S: two or more of Ctrl, Alt, Shift, Win, then a letter, digit or F1–F12.");
        }

        if (stop == share)
        {
            return Fail(SettingsField.ShareKey, "The stop key and the share key must differ.");
        }

        var owner = GitHubOwner.Trim();
        if (owner.Length > 0 && !CodeProjects.IsOwner(owner))
        {
            return Fail(SettingsField.GitHubOwner, "The GitHub owner is a GitHub user or organisation name: letters, digits and dashes.");
        }

        var folders = FileFolders.Split([';', '\n', '\r'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (folders.Any(f => !Path.IsPathFullyQualified(f)))
        {
            return Fail(SettingsField.FileFolders, "Each folder for files must be a full path; several are separated by ;.");
        }

        var settings = current with
        {
            Address = address.ToString(),
            PowerShellEnabled = PowerShellEnabled,
            WorkFolder = OrNull(WorkFolder),
            StopHotkey = stop.ToString(),
            ShareHotkey = share.ToString(),
            StartWithWindows = StartWithWindows,
            ShareCodeJobs = ShareCodeJobs,
            CodeJobsFolder = OrNull(CodeJobsFolder),
            StartCodeJobs = StartCodeJobs,
            CodeProjectsFolder = OrNull(CodeProjectsFolder),
            GitHubOwner = owner.Length == 0 ? null : owner,
            ShareFiles = ShareFiles,
            FileFolders = folders.Length == 0 ? null : folders,
        };
        return new SettingsCheck(settings, token.Length > 0 ? token : null, null);
    }

    private static SettingsCheck Fail(SettingsField field, string message) => new(null, null, new SettingsProblem(field, message));

    private static string? OrNull(string text) => string.IsNullOrWhiteSpace(text) ? null : text.Trim();
}
