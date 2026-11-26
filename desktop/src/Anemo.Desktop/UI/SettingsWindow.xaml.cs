using System;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using Anemo.Desktop.Core;
using Anemo.Desktop.Core.CodeJobs;
using Anemo.Desktop.Core.Connection;
using Anemo.Desktop.Core.Storage;
using Anemo.Desktop.Core.Updates;
using Anemo.Desktop.Platform;
using Microsoft.Win32;

namespace Anemo.Desktop.UI;

/// <summary>
/// The Settings window: Connection (address, token, status), This computer (PowerShell, its
/// folder, the stop and share keys, Start with Windows) and Claude Code (sharing jobs, starting
/// them). It follows the Windows light/dark setting. The rules are in <see cref="SettingsDraft"/>.
/// </summary>
internal sealed partial class SettingsWindow : Window
{
    private readonly Context _context;
    private ConnectionPhase _phase;

    public SettingsWindow(Context context)
    {
        _context = context;
        InitializeComponent();
        ApplyTheme();
        if (context.Icon is not null)
        {
            Icon = context.Icon;
        }

        VersionText.Text = "Version " + context.Version;
        Fill(SettingsDraft.From(context.Current));
        ShowPage(NavConnection);

        NavConnection.Checked += (_, _) => ShowPage(NavConnection);
        NavComputer.Checked += (_, _) => ShowPage(NavComputer);
        NavCode.Checked += (_, _) => ShowPage(NavCode);
        MinimizeButton.Click += (_, _) => WindowState = WindowState.Minimized;
        CloseButton.Click += (_, _) => Close();
        SaveButton.Click += (_, _) => TrySave();
        OpenAnemoButton.Click += (_, _) => context.OpenAnemo();
        CheckNowButton.Click += (_, _) => context.CheckForUpdate();
        RestartToUpdateButton.Click += (_, _) => context.RestartToUpdate();
        StatusLink.Click += (_, _) => OnStatusLink();
        WorkFolderBrowse.Click += (_, _) => Browse(WorkFolderBox, "The folder PowerShell starts in");
        JobsFolderBrowse.Click += (_, _) => Browse(JobsFolderBox, "The Claude Code jobs folder");
        ProjectsBrowse.Click += (_, _) => Browse(ProjectsBox, "The folder with your projects");
        TokenBox.PasswordChanged += (_, _) =>
        {
            ShowTokenHint();
            ClearError(SettingsField.Token);
        };
        AddressBox.TextChanged += (_, _) => ClearError(SettingsField.Address);
        OwnerBox.TextChanged += (_, _) => ClearError(SettingsField.GitHubOwner);
        FileFoldersBox.TextChanged += (_, _) => ClearError(SettingsField.FileFolders);
        StopKey.Changed += () => ClearError(SettingsField.StopKey);
        ShareKey.Changed += () => ClearError(SettingsField.ShareKey);
        ShareJobsSwitch.Click += (_, _) => ShowCodeJobs();
        StartJobsSwitch.Click += (_, _) => ShowCodeJobs();
        StateChanged += (_, _) => Frame.Margin = WindowState == WindowState.Maximized ? new Thickness(7) : default;
        SourceInitialized += (_, _) => StyleFrame();
        SystemEvents.UserPreferenceChanged += OnUserPreferenceChanged;
        Closed += (_, _) => SystemEvents.UserPreferenceChanged -= OnUserPreferenceChanged;
    }

    /// <param name="Save">Saves the settings and the new token; a sentence when that failed (the window stays open).</param>
    /// <param name="CheckForUpdate">"Check now": at once, whatever the switch says (the switch is saved with Save).</param>
    /// <param name="RestartToUpdate">"Restart to update": once nothing is running.</param>
    public sealed record Context(
        DesktopSettings Current,
        bool HasToken,
        string DefaultWorkFolder,
        string Version,
        Func<DesktopSettings, string?, string?> Save,
        Action OpenAnemo,
        ImageSource? Icon,
        Action CheckForUpdate,
        Action RestartToUpdate);

    /// <summary>The saved settings, after Save.</summary>
    public DesktopSettings? Result { get; private set; }

    /// <summary>The connection's state, in the sidebar and on the Connection page; called again when it changes.</summary>
    public void ShowStatus(StatusSummary status, ConnectionPhase phase)
    {
        _phase = phase;
        var palette = Palette.For(WindowsTheme.AppsAreDark);
        var (soft, text, dot) = palette.Tone(status.Tone);
        StatusChip.Background = Brush(soft);
        StatusDot.Fill = Brush(dot);
        StatusTitle.Foreground = Brush(text);
        StatusTitle.Text = status.Title;
        StatusDetail.Text = status.Detail;
        StatusLinkText.Text = phase == ConnectionPhase.NotConfigured ? "How to get a token" : "Open Anemo";
        StatusLinkIcon.Visibility = phase == ConnectionPhase.NotConfigured ? Visibility.Collapsed : Visibility.Visible;
        StatusLink.Visibility = phase == ConnectionPhase.NotConfigured || AnemoAddress.Parse(_context.Current.Address) is not null
            ? Visibility.Visible
            : Visibility.Collapsed;

        ConnTile.Background = Brush(soft);
        ConnIcon.Stroke = Brush(text);
        ConnTitle.Text = phase == ConnectionPhase.NotConfigured ? "Not set up yet" : status.Title;
        ConnDetail.Text = phase == ConnectionPhase.NotConfigured ? "Three steps, about a minute:" : status.Detail;
        SetupSteps.Visibility = phase == ConnectionPhase.NotConfigured ? Visibility.Visible : Visibility.Collapsed;
        OpenAnemoButton.Visibility = phase == ConnectionPhase.Connected ? Visibility.Visible : Visibility.Collapsed;
    }

    /// <summary>The updater's state on the This computer page; called again when it changes.</summary>
    public void ShowUpdate(UpdateState state, bool automatic)
    {
        UpdateStatus.Text = UpdateText.Status(state, automatic, _context.Version);
        CheckNowButton.IsEnabled = state.Phase is not (UpdatePhase.Unavailable or UpdatePhase.Checking or UpdatePhase.Downloading or UpdatePhase.WaitingToRestart);
        RestartToUpdateButton.Visibility = state.Phase == UpdatePhase.Ready ? Visibility.Visible : Visibility.Collapsed;
    }

    private static SolidColorBrush Brush(string hex, byte alpha = 255)
    {
        var brush = new SolidColorBrush(Palette.Media(hex, alpha));
        brush.Freeze();
        return brush;
    }

    private void Fill(SettingsDraft draft)
    {
        AddressBox.Text = draft.Address;
        ShowTokenHint();
        PowerShellSwitch.IsChecked = draft.PowerShellEnabled;
        WorkFolderBox.Text = draft.WorkFolder;
        WorkFolderBox.Tag = _context.DefaultWorkFolder;
        StopKey.Keys = draft.StopHotkey;
        ShareKey.Keys = draft.ShareHotkey;
        StartupSwitch.IsChecked = draft.StartWithWindows;
        ShareJobsSwitch.IsChecked = draft.ShareCodeJobs;
        JobsFolderBox.Text = draft.CodeJobsFolder;
        JobsFolderBox.Tag = CodeJobLimits.DefaultFolder;
        StartJobsSwitch.IsChecked = draft.StartCodeJobs;
        ProjectsBox.Text = draft.CodeProjectsFolder;
        ProjectsBox.Tag = CodeJobLimits.DefaultProjectsFolder;
        OwnerBox.Text = draft.GitHubOwner;
        OwnerBox.Tag = "The account gh is signed in as";
        FilesSwitch.IsChecked = draft.ShareFiles;
        FileFoldersBox.Text = draft.FileFolders;
        FileFoldersBox.Tag = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        UpdateSwitch.IsChecked = draft.AutoUpdate;
        ShowCodeJobs();
    }

    private SettingsDraft Draft() => new()
    {
        Address = AddressBox.Text,
        Token = TokenBox.Password,
        PowerShellEnabled = PowerShellSwitch.IsChecked == true,
        WorkFolder = WorkFolderBox.Text,
        StopHotkey = StopKey.Keys,
        ShareHotkey = ShareKey.Keys,
        StartWithWindows = StartupSwitch.IsChecked == true,
        ShareCodeJobs = ShareJobsSwitch.IsChecked == true,
        CodeJobsFolder = JobsFolderBox.Text,
        StartCodeJobs = StartJobsSwitch.IsChecked == true,
        CodeProjectsFolder = ProjectsBox.Text,
        GitHubOwner = OwnerBox.Text,
        ShareFiles = FilesSwitch.IsChecked == true,
        FileFolders = FileFoldersBox.Text,
        AutoUpdate = UpdateSwitch.IsChecked == true,
    };

    private void TrySave()
    {
        ShowFooter(null);
        var check = Draft().Check(_context.Current);
        if (check.Problem is { } problem)
        {
            ShowError(problem);
            return;
        }

        if (_context.Save(check.Settings!, check.NewToken) is { } failed)
        {
            ShowFooter(failed); // e.g. Windows couldn't protect the token
            return;
        }

        Result = check.Settings;
        DialogResult = true;
    }

    private void ShowPage(RadioButton nav)
    {
        nav.IsChecked = true;
        PageConnection.Visibility = nav == NavConnection ? Visibility.Visible : Visibility.Collapsed;
        PageComputer.Visibility = nav == NavComputer ? Visibility.Visible : Visibility.Collapsed;
        PageCode.Visibility = nav == NavCode ? Visibility.Visible : Visibility.Collapsed;
        PageTitle.Text = (string)nav.Content;
        PageSubtitle.Text = nav == NavConnection
            ? "Which Anemo this computer connects to, and how it signs in."
            : nav == NavComputer
                ? "What Anemo’s agents may do here, and the keys that stop or share."
                : "Claude Code jobs on this computer, seen from Anemo.";
    }

    private void OnStatusLink()
    {
        if (_phase == ConnectionPhase.NotConfigured)
        {
            ShowPage(NavConnection);
            AddressBox.Focus();
        }
        else
        {
            _context.OpenAnemo();
        }
    }

    private void ShowTokenHint()
    {
        var empty = TokenBox.Password.Length == 0;
        TokenPlaceholder.Text = _context.HasToken ? "A token is saved; paste a new one to replace it" : "anemo_…";
        TokenPlaceholder.Visibility = empty ? Visibility.Visible : Visibility.Collapsed;
        TokenSaved.Visibility = empty && _context.HasToken ? Visibility.Visible : Visibility.Collapsed;
    }

    /// <summary>Starting jobs needs sharing (a job Anemo starts must be visible to it).</summary>
    private void ShowCodeJobs()
    {
        var palette = Palette.For(WindowsTheme.AppsAreDark);
        var share = ShareJobsSwitch.IsChecked == true;
        var start = share && StartJobsSwitch.IsChecked == true;
        StartJobsSwitch.IsEnabled = share;
        StartJobsDetail.Text = share
            ? "Anemo’s agents can start a job in one of your projects."
            : "Turn on sharing first: a job Anemo starts must be visible to it.";
        StartJobsFields.IsEnabled = start;
        StartJobsFields.Opacity = start ? 1 : 0.5;
        BypassWarning.Opacity = start ? 1 : 0.55;
        ShareJobsTile.Background = Brush(share ? palette.AccentSoft : palette.Inset);
        ShareJobsIcon.Stroke = Brush(share ? palette.Accent : palette.Muted);
        StartJobsTile.Background = Brush(start ? palette.WarnSoft : palette.Inset);
        StartJobsIcon.Stroke = Brush(start ? palette.Warn : palette.Muted);
    }

    private void Browse(TextBox box, string title)
    {
        var start = string.IsNullOrWhiteSpace(box.Text) ? box.Tag as string : box.Text.Trim();
        var dialog = new OpenFolderDialog { Title = title };
        if (start is not null && Directory.Exists(start))
        {
            dialog.InitialDirectory = start;
        }

        if (dialog.ShowDialog(this) == true)
        {
            box.Text = dialog.FolderName;
        }
    }

    private void ShowError(SettingsProblem problem)
    {
        ShowFooter("Fix the highlighted field to save.");
        switch (problem.Field)
        {
            case SettingsField.Address:
                ShowPage(NavConnection);
                MarkBox(AddressBox, true);
                AddressErrorText.Text = problem.Message;
                AddressError.Visibility = Visibility.Visible;
                AddressHelp.Visibility = Visibility.Collapsed;
                AddressBox.Focus();
                break;
            case SettingsField.Token:
                ShowPage(NavConnection);
                MarkBox(TokenBox, true);
                TokenErrorText.Text = problem.Message;
                TokenError.Visibility = Visibility.Visible;
                TokenBox.Focus();
                break;
            case SettingsField.StopKey:
            case SettingsField.ShareKey:
                ShowPage(NavComputer);
                (problem.Field == SettingsField.StopKey ? StopKey : ShareKey).SetError(true);
                KeyErrorText.Text = problem.Message;
                KeyError.Visibility = Visibility.Visible;
                break;
            case SettingsField.GitHubOwner:
                ShowPage(NavCode);
                MarkBox(OwnerBox, true);
                OwnerErrorText.Text = problem.Message;
                OwnerError.Visibility = Visibility.Visible;
                OwnerHelp.Visibility = Visibility.Collapsed;
                OwnerBox.Focus();
                break;
            case SettingsField.FileFolders:
                ShowPage(NavComputer);
                MarkBox(FileFoldersBox, true);
                FileFoldersErrorText.Text = problem.Message;
                FileFoldersError.Visibility = Visibility.Visible;
                FileFoldersHelp.Visibility = Visibility.Collapsed;
                FileFoldersBox.Focus();
                break;
        }
    }

    private void ClearError(SettingsField field)
    {
        switch (field)
        {
            case SettingsField.Address:
                MarkBox(AddressBox, false);
                AddressError.Visibility = Visibility.Collapsed;
                AddressHelp.Visibility = Visibility.Visible;
                break;
            case SettingsField.Token:
                MarkBox(TokenBox, false);
                TokenError.Visibility = Visibility.Collapsed;
                break;
            case SettingsField.StopKey:
            case SettingsField.ShareKey:
                StopKey.SetError(false);
                ShareKey.SetError(false);
                KeyError.Visibility = Visibility.Collapsed;
                break;
            case SettingsField.GitHubOwner:
                MarkBox(OwnerBox, false);
                OwnerError.Visibility = Visibility.Collapsed;
                OwnerHelp.Visibility = Visibility.Visible;
                break;
            case SettingsField.FileFolders:
                MarkBox(FileFoldersBox, false);
                FileFoldersError.Visibility = Visibility.Collapsed;
                FileFoldersHelp.Visibility = Visibility.Visible;
                break;
        }

        ShowFooter(null);
    }

    private static void MarkBox(Control box, bool error)
    {
        box.SetResourceReference(Control.BorderBrushProperty, error ? "ErrorDot" : "Edge");
        box.BorderThickness = new Thickness(error ? 1.5 : 1);
    }

    private void ShowFooter(string? error)
    {
        FooterMessage.Visibility = error is null ? Visibility.Collapsed : Visibility.Visible;
        FooterText.Text = error ?? "";
        FooterText.SetResourceReference(TextBlock.ForegroundProperty, "Error");
        FooterIcon.SetResourceReference(LineIcon.StrokeProperty, "Error");
    }

    private void OnUserPreferenceChanged(object sender, UserPreferenceChangedEventArgs e)
    {
        if (e.Category == UserPreferenceCategory.General)
        {
            Dispatcher.BeginInvoke(() =>
            {
                ApplyTheme();
                StyleFrame();
                ShowCodeJobs();
            });
        }
    }

    /// <summary>The brushes the XAML asks for (DynamicResource), light or dark like Windows' apps.</summary>
    private void ApplyTheme()
    {
        var dark = WindowsTheme.AppsAreDark;
        var p = Palette.For(dark);
        void Set(string key, string hex, byte alpha = 255) => Resources[key] = Brush(hex, alpha);
        Set("Ground", p.Ground);
        Set("Card", p.Card);
        Set("Inset", p.Inset);
        Set("Raised", p.Raised);
        Set("Field", p.Field);
        Set("Edge", p.Edge);
        Set("Text", p.Text);
        Set("Muted", p.Muted);
        Set("Subtle", p.Subtle);
        Set("Accent", p.Accent);
        Set("OnAccent", p.OnAccent);
        Set("AccentSoft", p.AccentSoft);
        Set("Ok", p.Ok);
        Set("OkDot", p.OkDot);
        Set("OkSoft", p.OkSoft);
        Set("Warn", p.Warn);
        Set("WarnDot", p.WarnDot);
        Set("WarnSoft", p.WarnSoft);
        Set("Error", p.Error);
        Set("ErrorDot", p.ErrorDot);
        Set("ErrorSoft", p.ErrorSoft);
        Set("SwitchOff", p.Switch);
        Set("Hover", dark ? "#FFFFFF" : "#0F141E", 12);
        Set("Hairline", dark ? "#FFFFFF" : "#0F141E", 20);
        Set("CardEdge", "#FFFFFF", dark ? (byte)16 : (byte)0);
        Set("ScrollThumb", dark ? "#FFFFFF" : "#0F141E", 60);
        Resources["ShadowColor"] = dark ? Colors.Black : Palette.Media("#121C38");
        Resources["ShadowOpacity"] = dark ? 0.35 : 0.10;
        Resources["NavShadowOpacity"] = dark ? 0.4 : 0.14;
        BrandLogo.Edge = dark;
    }

    /// <summary>Windows 11: round corners and a border that matches the theme.</summary>
    private void StyleFrame()
    {
        var handle = new WindowInteropHelper(this).Handle;
        if (handle == IntPtr.Zero)
        {
            return;
        }

        var dark = WindowsTheme.AppsAreDark;
        WindowsTheme.SetDarkFrame(handle, dark);
        WindowsTheme.SetCorners(handle, WindowsTheme.Corners.Round);
        var (r, g, b) = Palette.Rgb(Palette.For(dark).Edge);
        WindowsTheme.SetBorderColor(handle, r, g, b);
    }
}

/// <summary><c>ui:Field.Icon="folder"</c>: the line icon at the start of a field.</summary>
internal static class Field
{
    public static readonly DependencyProperty IconProperty = DependencyProperty.RegisterAttached(
        "Icon", typeof(string), typeof(Field), new PropertyMetadata(null));

    public static string? GetIcon(DependencyObject element) => (string?)element.GetValue(IconProperty);

    public static void SetIcon(DependencyObject element, string? value) => element.SetValue(IconProperty, value);
}
