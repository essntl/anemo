using Anemo.Desktop.Core;
using Anemo.Desktop.Core.Storage;
using Anemo.Desktop.Core.Updates;
using Avalonia.Controls;
using Avalonia.Markup.Xaml;

namespace Anemo.Desktop.Mac.UI;

/// <summary>
/// The settings, checked by Core's <see cref="SettingsDraft"/> as on Windows. The token is
/// never shown again: the box stays empty unless a new one is pasted.
/// </summary>
public sealed partial class SettingsWindow : Window
{
    private readonly DesktopSettings _current;
    private readonly Func<DesktopSettings, string?, string?> _save;
    private readonly string _version;

    /// <summary>For Avalonia's designer and XAML loader only.</summary>
    public SettingsWindow()
        : this(new DesktopSettings(), false, "", (_, _) => null, () => { }, () => { }, null)
    {
    }

    /// <param name="save">Saves; returns a sentence when it failed (the window then stays open).</param>
    /// <param name="checkNow">"Check now": at once, whatever the box says (the box is saved with Save).</param>
    /// <param name="restart">"Restart to update": once nothing is running.</param>
    /// <param name="updateNote">What an update costs here (ad hoc builds lose their permissions), or null.</param>
    public SettingsWindow(
        DesktopSettings current,
        bool hasToken,
        string version,
        Func<DesktopSettings, string?, string?> save,
        Action checkNow,
        Action restart,
        string? updateNote)
    {
        _current = current;
        _save = save;
        _version = version;
        AvaloniaXamlLoader.Load(this);
        Icon = Icons.App;

        var draft = SettingsDraft.From(current);
        Box("Address").Text = draft.Address;
        Find<TextBlock>("TokenHint").Text = hasToken ? "A token is saved in the Keychain. Paste a new one only to replace it." : "No token yet.";
        Find<CheckBox>("ShellSwitch").IsChecked = draft.PowerShellEnabled;
        Box("WorkFolder").Text = draft.WorkFolder;
        Box("WorkFolder").Watermark = AppPaths.DefaultWorkFolder;
        Box("StopKey").Text = draft.StopHotkey;
        Box("ShareKey").Text = draft.ShareHotkey;
        Find<CheckBox>("OpenAtLogin").IsChecked = draft.StartWithWindows;
        Find<CheckBox>("ShareJobs").IsChecked = draft.ShareCodeJobs;
        Box("JobsFolder").Text = draft.CodeJobsFolder;
        Box("JobsFolder").Watermark = Core.Platform.DesktopPlatform.MacOS(AppPaths.HomeFolder).DefaultJobsFolder;
        Find<CheckBox>("StartJobs").IsChecked = draft.StartCodeJobs;
        Box("ProjectsFolder").Text = draft.CodeProjectsFolder;
        Box("ProjectsFolder").Watermark = Core.Platform.DesktopPlatform.MacOS(AppPaths.HomeFolder).DefaultProjectsFolder;
        Box("GitHubOwner").Text = draft.GitHubOwner;
        Find<CheckBox>("FilesSwitch").IsChecked = draft.ShareFiles;
        Box("FileFolders").Text = draft.FileFolders;
        Box("FileFolders").Watermark = AppPaths.HomeFolder;
        Find<CheckBox>("AutoUpdate").IsChecked = draft.AutoUpdate;
        Find<TextBlock>("UpdateNote").Text = updateNote ?? "";
        Find<TextBlock>("UpdateNote").IsVisible = updateNote is not null;
        Find<Button>("CheckNow").Click += (_, _) => checkNow();
        Find<Button>("RestartToUpdate").Click += (_, _) => restart();
        Find<TextBlock>("Version").Text = $"Anemo Desktop {version} for macOS";

        Find<Button>("Cancel").Click += (_, _) => Close();
        Find<Button>("Save").Click += (_, _) => OnSave();
    }

    public void ShowStatus(StatusSummary summary)
    {
        Find<TextBlock>("StatusTitle").Text = summary.Title;
        Find<TextBlock>("StatusDetail").Text = summary.Detail;
    }

    /// <summary>The updater's state; called again when it changes.</summary>
    public void ShowUpdate(UpdateState state, bool automatic)
    {
        Find<TextBlock>("UpdateStatus").Text = UpdateText.Status(state, automatic, _version);
        Find<Button>("CheckNow").IsEnabled = state.Phase is not (UpdatePhase.Unavailable or UpdatePhase.Checking or UpdatePhase.Downloading or UpdatePhase.WaitingToRestart);
        Find<Button>("RestartToUpdate").IsVisible = state.Phase == UpdatePhase.Ready;
    }

    private void OnSave()
    {
        var draft = new SettingsDraft
        {
            Address = Box("Address").Text ?? "",
            Token = Box("Token").Text ?? "",
            PowerShellEnabled = Find<CheckBox>("ShellSwitch").IsChecked == true,
            WorkFolder = Box("WorkFolder").Text ?? "",
            StopHotkey = Box("StopKey").Text ?? "",
            ShareHotkey = Box("ShareKey").Text ?? "",
            StartWithWindows = Find<CheckBox>("OpenAtLogin").IsChecked == true,
            ShareCodeJobs = Find<CheckBox>("ShareJobs").IsChecked == true,
            CodeJobsFolder = Box("JobsFolder").Text ?? "",
            StartCodeJobs = Find<CheckBox>("StartJobs").IsChecked == true,
            CodeProjectsFolder = Box("ProjectsFolder").Text ?? "",
            GitHubOwner = Box("GitHubOwner").Text ?? "",
            ShareFiles = Find<CheckBox>("FilesSwitch").IsChecked == true,
            FileFolders = Box("FileFolders").Text ?? "",
            AutoUpdate = Find<CheckBox>("AutoUpdate").IsChecked == true,
        };
        var check = draft.Check(_current);
        if (!check.Ok)
        {
            Find<TextBlock>("Problem").Text = check.Problem!.Message;
            Box(FieldBox(check.Problem.Field)).Focus();
            return;
        }

        if (_save(check.Settings!, check.NewToken) is { } failed)
        {
            Find<TextBlock>("Problem").Text = failed;
            return;
        }

        Close();
    }

    private static string FieldBox(SettingsField field) => field switch
    {
        SettingsField.Address => "Address",
        SettingsField.Token => "Token",
        SettingsField.StopKey => "StopKey",
        SettingsField.ShareKey => "ShareKey",
        SettingsField.FileFolders => "FileFolders",
        _ => "GitHubOwner",
    };

    private TextBox Box(string name) => Find<TextBox>(name);

    private T Find<T>(string name)
        where T : Control =>
        this.FindControl<T>(name) ?? throw new InvalidOperationException($"{name} is missing from the window.");
}
