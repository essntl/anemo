using System;
using System.Diagnostics;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Anemo.Desktop.Core;
using Anemo.Desktop.Core.Connection;
using Anemo.Desktop.Core.Control;
using Anemo.Desktop.Core.Platform;
using Anemo.Desktop.Core.Storage;
using Anemo.Desktop.Core.Updates;
using Anemo.Desktop.Platform;
using Microsoft.Win32;

namespace Anemo.Desktop.UI;

/// <summary>
/// The tray icon and its menu, the hotkeys, the indicator and the Settings window, around
/// a <see cref="DesktopAgent"/> that does the work.
/// </summary>
internal sealed class TrayApp : ApplicationContext
{
    private static readonly TimeSpan IndicatorLinger = TimeSpan.FromSeconds(2);

    private readonly DesktopAgent _agent;
    private readonly IDiagnosticLog _log;
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(60) };
    private readonly CancellationTokenSource _quit = new();
    private readonly Control _ui = new();
    private readonly TrayIcons _icons = new();
    private readonly NotifyIcon _tray = new();
    private readonly HotkeyWindow _hotkeys = new();
    private readonly Indicator _indicator;
    private readonly System.Windows.Forms.Timer _hideIndicator = new();
    private readonly System.Windows.Forms.Timer _refresh = new() { Interval = 15_000 };
    private readonly ToolStripMenuItem _share = new("Share this screen with Anemo");
    private readonly ToolStripMenuItem _pause = new("Pause control for 1 hour");
    private readonly ToolStripMenuItem _allow = new("Allow control") { CheckOnClick = true };
    private readonly ToolStripMenuItem _update = new("Restart to update") { Visible = false };
    private readonly ToolStripSeparator _updateLine = new() { Visible = false };
    private readonly TrayMenu _menu = new();
    private readonly string _version;
    private bool _busy;
    private SettingsWindow? _settingsWindow;
    private Install? _restart;

    /// <param name="updated">Started by an update (<c>--updated</c>): tell the old copy, which waits, that this one is up.</param>
    public TrayApp(bool updated)
    {
        _ui.CreateControl();
        var time = TimeProvider.System;
        _log = new DiagnosticLog(AppPaths.LogFolder, time);
        var version = typeof(TrayApp).Assembly.GetName().Version?.ToString(3) ?? "1.0.0";
        _version = version;
        _agent = new DesktopAgent(new DesktopAgentParts(
            new SettingsStore(AppPaths.SettingsFile, new DpapiProtector()),
            new PlatformServices(new WindowsDesktop(), new SendInputDevice(), new WindowsClipboard(), new StartMenuLauncher(), new PowerShellHost()),
            new CommandLog(AppPaths.LogFolder, time),
            _log,
            time,
            _http,
            version,
            AppPaths.DefaultWorkFolder,
            Processes: new WindowsProcessProbe(),
            CodeHost: new WindowsCodeHost(),
            Updates: new WindowsUpdatePlatform(
                Environment.ProcessPath,
                // A build from dotnet build is a launcher beside "Anemo Desktop.dll"; the published exe has no dll.
                singleFile: Environment.ProcessPath is { } exe && !System.IO.File.Exists(System.IO.Path.ChangeExtension(exe, ".dll")),
                System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture),
            UpdateOptions: UpdateOptions.FromBuild(typeof(TrayApp).Assembly)));

        _indicator = new Indicator(() => _agent.Control.Stop(), () => _agent.Settings.StopHotkey);
        _hideIndicator.Interval = (int)IndicatorLinger.TotalMilliseconds;
        _hideIndicator.Tick += (_, _) =>
        {
            _hideIndicator.Stop();
            _indicator.Hide();
        };
        _refresh.Tick += (_, _) => Refresh();

        BuildMenu();
        _tray.Visible = true;
        _tray.DoubleClick += (_, _) => ShowSettings();

        _agent.Connection.StatusChanged += status => OnUi(() => OnStatus(status));
        _agent.Connection.CommandRunning += action => OnUi(() => OnCommand(action));
        _agent.Connection.NoticeReceived += text => OnUi(() => Balloon(text, ToolTipIcon.Info));
        _agent.Control.Changed += () => OnUi(Refresh);
        _agent.Updates.Changed += () => OnUi(Refresh);
        _agent.Updates.RestartRequested += update => OnUi(() => QuitToInstall(update));
        SystemEvents.SessionEnded += OnSessionEnded;

        RegisterHotkeys();
        ApplyStartup();
        Refresh();
        _refresh.Start();
        _ = Task.Run(() => _agent.RunAsync(_quit.Token));

        if (_agent.StartupProblem is { } problem)
        {
            _ui.BeginInvoke(() => Balloon(problem, ToolTipIcon.Warning));
        }

        if (!_agent.HasToken)
        {
            // After Application.Run has started, not inside this constructor.
            _ui.BeginInvoke(ShowSettings);
        }

        if (updated)
        {
            _ui.BeginInvoke(() =>
            {
                _agent.Updates.ReportStarted();
                Balloon($"Anemo Desktop was updated to {_version}.", ToolTipIcon.Info);
            });
        }
    }

    /// <summary>What Program does after the tray is gone: swap the update in, and start it for a restart.</summary>
    public sealed record Install(UpdateInstaller Installer, StagedUpdate Update, bool Restart);

    /// <summary>The install for after the message loop: the restart that was asked for, else a ready update (installed at quit).</summary>
    public Install? TakeInstall()
    {
        if (_restart is { } restart)
        {
            _restart = null;
            return restart;
        }

        return _agent.Updates.TakeReady() is { } ready ? new Install(_agent.Installer, ready, Restart: false) : null;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _quit.Cancel();
            SystemEvents.SessionEnded -= OnSessionEnded;
            _tray.Visible = false;
            _tray.Dispose();
            _hotkeys.Dispose();
            _indicator.Dispose();
            _icons.Dispose();
            _menu.Strip.Dispose();
            _hideIndicator.Dispose();
            _refresh.Dispose();
            _http.Dispose();
            _ui.Dispose();
        }

        base.Dispose(disposing);
    }

    private void BuildMenu()
    {
        _share.Click += (_, _) => _ = ShareAsync();
        _pause.Click += (_, _) =>
        {
            if (_agent.Control.PausedUntil is null)
            {
                _agent.Control.Stop();
            }
            else
            {
                _agent.Control.Resume();
            }
        };
        _allow.Click += (_, _) => _agent.Control.SetAllow(_allow.Checked);
        _update.Click += (_, _) => _agent.Updates.RestartToUpdate();
        _menu.Add(_update, "download");
        _menu.Strip.Items.Add(_updateLine);
        _menu.Add(_share, "share");
        _menu.Add(_pause, "pause");
        _menu.Add(_allow, "pointer");
        _menu.AddSeparator();
        _menu.Add(new ToolStripMenuItem("Open Anemo", null, (_, _) => OpenAnemo()), "external");
        _menu.Add(new ToolStripMenuItem("Settings…", null, (_, _) => ShowSettings()), "sliders");
        _menu.Add(new ToolStripMenuItem("Command log", null, (_, _) => OpenFolder(AppPaths.LogFolder)), "list");
        _menu.AddSeparator();
        _menu.Add(new ToolStripMenuItem("Quit", null, (_, _) => ExitThread()), "logout");
        _menu.BeforeOpen = Refresh;
        _tray.ContextMenuStrip = _menu.Strip;
    }

    private void RegisterHotkeys()
    {
        _hotkeys.UnregisterAll();
        var settings = _agent.Settings;
        var stop = Hotkey.Parse(settings.StopHotkey) ?? Hotkey.Parse(Hotkey.DefaultStop)!;
        var share = Hotkey.Parse(settings.ShareHotkey) ?? Hotkey.Parse(Hotkey.DefaultShare)!;
        if (!_hotkeys.Register(stop, () => _agent.Control.Stop()))
        {
            Balloon($"The stop key {stop} is used by another program. Choose another one in Settings.", ToolTipIcon.Warning);
        }

        if (!_hotkeys.Register(share, () => _ = ShareAsync()))
        {
            Balloon($"The share key {share} is used by another program. Choose another one in Settings.", ToolTipIcon.Warning);
        }

        _share.ShortcutKeyDisplayString = share.ToString();
        _pause.ShortcutKeyDisplayString = stop.ToString();
    }

    private void ApplyStartup()
    {
        try
        {
            StartupShortcut.Apply(_agent.Settings.StartWithWindows);
        }
        catch (Exception e)
        {
            _log.Info($"startup shortcut not changed: {e.GetType().Name}");
        }
    }

    private void OnStatus(ConnectionStatus status)
    {
        if (status.Phase == ConnectionPhase.Refused && status.Message is { } message)
        {
            Balloon(message, ToolTipIcon.Warning);
        }

        Refresh();
    }

    private void OnCommand(string? action)
    {
        _busy = action is not null;
        if (_busy)
        {
            _hideIndicator.Stop();
            _indicator.ShowInCorner();
        }
        else
        {
            _hideIndicator.Start();
        }

        Refresh();
    }

    private void Refresh()
    {
        var status = _agent.Connection.Status;
        _tray.Icon = _icons.For(TrayStatus.Icon(status, _busy, _agent.Control));
        var tooltip = TrayStatus.Tooltip(status, _busy, _agent.Control);
        if (UpdateText.Tooltip(_agent.Updates.State) is { } update && tooltip.Length + update.Length < TrayStatus.MaxTooltip)
        {
            tooltip += "\n" + update;
        }

        _tray.Text = tooltip;
        var updateItem = UpdateText.MenuItem(_agent.Updates.State);
        _update.Visible = _updateLine.Visible = updateItem is not null;
        _update.Text = updateItem ?? "";
        ShowStatusInSettings();
        _menu.Status = TrayStatus.Summary(status, _busy, _agent.Control, _agent.Connection.Device);
        _allow.Checked = _agent.Control.AllowControl;
        var paused = _agent.Control.PausedUntil;
        _pause.Text = paused is { } until
            ? $"Resume control (paused until {until.ToLocalTime():HH:mm})"
            : "Pause control for 1 hour";
        _menu.SetIcon(_pause, paused is null ? "pause" : "play");
    }

    private async Task ShareAsync()
    {
        var result = await _agent.ShareScreenAsync(_quit.Token);
        OnUi(() => Balloon(result.Message, result.Ok ? ToolTipIcon.Info : ToolTipIcon.Warning));
    }

    private void ShowSettings()
    {
        if (_settingsWindow is not null)
        {
            _settingsWindow.Activate();
            return;
        }

        var window = new SettingsWindow(new SettingsWindow.Context(
            _agent.Settings,
            _agent.HasToken,
            AppPaths.DefaultWorkFolder,
            _version,
            SaveSettings,
            OpenAnemo,
            _icons.AppImage,
            () => _ = _agent.Updates.CheckNowAsync(_quit.Token),
            () => _agent.Updates.RestartToUpdate()));
        _settingsWindow = window;
        ShowStatusInSettings();
        try
        {
            if (window.ShowDialog() == true)
            {
                RegisterHotkeys();
                ApplyStartup();
                Refresh();
            }
        }
        finally
        {
            _settingsWindow = null;
        }
    }

    private void ShowStatusInSettings()
    {
        var status = _agent.Connection.Status;
        _settingsWindow?.ShowStatus(TrayStatus.Summary(status, _busy, _agent.Control, _agent.Connection.Device), status.Phase);
        _settingsWindow?.ShowUpdate(_agent.Updates.State, _agent.Settings.AutoUpdate);
    }

    /// <summary>"Restart to update" found nothing running: close the windows and leave the loop; Program swaps and restarts.</summary>
    private void QuitToInstall(StagedUpdate update)
    {
        _restart = new Install(_agent.Installer, update, Restart: true);
        if (_settingsWindow is { } window)
        {
            window.Close(); // ends its ShowDialog; the loop is left after that
            _ui.BeginInvoke(ExitThread);
        }
        else
        {
            ExitThread();
        }
    }

    /// <summary>Windows is signing out or shutting down: a ready update is swapped in now (three renames), not restarted.</summary>
    private void OnSessionEnded(object? sender, SessionEndedEventArgs e)
    {
        if (TakeInstall() is { } install)
        {
            install.Installer.InstallOnQuit(install.Update);
        }
    }

    /// <summary>Saves from the Settings window; a sentence when it failed (the window stays open).</summary>
    private string? SaveSettings(DesktopSettings settings, string? newToken)
    {
        try
        {
            _agent.Save(settings, newToken);
            return null;
        }
        catch (SettingsSaveException e)
        {
            _log.Info($"settings not saved: {e.InnerException?.GetType().Name}");
            return e.Message;
        }
    }

    private void OpenAnemo()
    {
        if (AnemoAddress.Parse(_agent.Settings.Address) is { } address)
        {
            Process.Start(new ProcessStartInfo(address.BaseUri.AbsoluteUri) { UseShellExecute = true });
        }
        else
        {
            ShowSettings();
        }
    }

    private static void OpenFolder(string folder)
    {
        System.IO.Directory.CreateDirectory(folder);
        Process.Start(new ProcessStartInfo("explorer.exe", $"\"{folder}\"") { UseShellExecute = true });
    }

    private void Balloon(string text, ToolTipIcon icon) => _tray.ShowBalloonTip(5000, "Anemo Desktop", text, icon);

    private void OnUi(Action action)
    {
        if (_ui.IsDisposed)
        {
            return;
        }

        if (_ui.InvokeRequired)
        {
            _ui.BeginInvoke(action);
        }
        else
        {
            action();
        }
    }
}
