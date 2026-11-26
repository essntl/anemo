using System.Diagnostics;
using Anemo.Desktop.Core;
using TrayIcon = Avalonia.Controls.TrayIcon;
using Anemo.Desktop.Core.Connection;
using Anemo.Desktop.Core.Control;
using Anemo.Desktop.Core.Platform;
using Anemo.Desktop.Core.Storage;
using Anemo.Desktop.Core.Updates;
using Anemo.Desktop.Mac.Platform;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Threading;

namespace Anemo.Desktop.Mac.UI;

/// <summary>
/// The menu bar item and its menu, the hot keys, the indicator, the Settings and Permissions
/// windows, around a <see cref="DesktopAgent"/> that does the work. The Mac's counterpart of
/// the Windows client's TrayApp, with the same menu.
/// </summary>
internal sealed class MenuBarApp : IDisposable
{
    private static readonly TimeSpan IndicatorLinger = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan PermissionNagEvery = TimeSpan.FromMinutes(10);

    private readonly DesktopAgent _agent;
    private readonly IDiagnosticLog _log;
    private readonly Action _quitApp;
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(60) };
    private readonly CancellationTokenSource _quit = new();
    private readonly TrayIcon _tray;
    private readonly HotKeys _hotKeys = new();
    private readonly IndicatorWindow _indicator;
    private readonly DispatcherTimer _hideIndicator = new() { Interval = IndicatorLinger };
    private readonly DispatcherTimer _refresh = new() { Interval = TimeSpan.FromSeconds(5) };
    private readonly NativeMenuItem _status = new() { IsEnabled = false };
    private readonly NativeMenuItem _share = new("Share this screen with Anemo");
    private readonly NativeMenuItem _pause = new("Pause control for 1 hour");
    private readonly NativeMenuItem _allow = new("Allow control") { ToggleType = NativeMenuItemToggleType.CheckBox };
    private readonly NativeMenuItem _update = new("Restart to update") { IsVisible = false };
    private readonly NativeMenuItemSeparator _updateLine = new() { IsVisible = false };
    private readonly string _version;
    private bool _busy;
    private DateTimeOffset _lastNag = DateTimeOffset.MinValue;
    private SettingsWindow? _settingsWindow;
    private PermissionsWindow? _permissionsWindow;
    private Install? _restart;

    /// <param name="updated">Started by an update (<c>--updated</c>): tell the old copy, which waits, that this one is up.</param>
    public MenuBarApp(Application app, Action quit, bool updated)
    {
        _quitApp = quit;
        var time = TimeProvider.System;
        _log = new DiagnosticLog(AppPaths.LogFolder, time);
        _version = typeof(MenuBarApp).Assembly.GetName().Version?.ToString(3) ?? "1.0.0";
        _agent = new DesktopAgent(new DesktopAgentParts(
            new SettingsStore(AppPaths.SettingsFile, new KeychainTokenProtector()),
            new PlatformServices(new MacDesktop(), new MacInput(), new MacClipboard(), new MacApps(), new MacShellHost()),
            new CommandLog(AppPaths.LogFolder, time),
            _log,
            time,
            _http,
            _version,
            AppPaths.DefaultWorkFolder,
            Processes: new MacProcessProbe(),
            CodeHost: new MacCodeHost(),
            TargetSystem: DesktopPlatform.MacOS(AppPaths.HomeFolder),
            Updates: new MacUpdatePlatform(
                Environment.ProcessPath, AppPaths.UpdatesFolder, System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture),
            UpdateOptions: UpdateOptions.FromBuild(typeof(MenuBarApp).Assembly)));

        _indicator = new IndicatorWindow(() => _agent.Control.Stop(), () => _agent.Settings.StopHotkey);
        _hideIndicator.Tick += (_, _) =>
        {
            _hideIndicator.Stop();
            _indicator.Hide();
        };
        _refresh.Tick += (_, _) => Refresh();

        _tray = new TrayIcon { Icon = Icons.Tray(Core.TrayIcon.Grey), ToolTipText = "Anemo Desktop", Menu = BuildMenu() };
        TrayIcon.SetIcons(app, [_tray]);

        _agent.Connection.StatusChanged += status => Dispatcher.UIThread.Post(() => OnStatus(status));
        _agent.Connection.CommandRunning += action => Dispatcher.UIThread.Post(() => OnCommand(action));
        _agent.Connection.NoticeReceived += text => Dispatcher.UIThread.Post(() => Notice.Show(text));
        _agent.Control.Changed += () => Dispatcher.UIThread.Post(Refresh);
        Permissions.Missing += () => Dispatcher.UIThread.Post(NagAboutPermissions);
        _agent.Updates.Changed += () => Dispatcher.UIThread.Post(Refresh);
        _agent.Updates.RestartRequested += update => Dispatcher.UIThread.Post(() => QuitToInstall(update));

        RegisterHotKeys();
        ApplyLoginItem();
        Refresh();
        _refresh.Start();
        _ = Task.Run(() => _agent.RunAsync(_quit.Token));

        if (_agent.StartupProblem is { } problem)
        {
            Dispatcher.UIThread.Post(() => Notice.Show(problem));
        }

        if (!_agent.HasToken)
        {
            Dispatcher.UIThread.Post(ShowSettings);
        }

        if (!Permissions.AllGranted)
        {
            Dispatcher.UIThread.Post(ShowPermissions);
        }

        if (updated)
        {
            Dispatcher.UIThread.Post(() =>
            {
                _agent.Updates.ReportStarted();
                Notice.Show(Permissions.AllGranted
                    ? $"Anemo Desktop was updated to {_version}."
                    : $"Anemo Desktop was updated to {_version}. macOS asks again for its permissions: remove Anemo Desktop from both lists in System Settings, then allow it again.");
            });
        }
    }

    /// <summary>What Program does after the app has closed: swap the update in, and start it for a restart.</summary>
    public sealed record Install(UpdateInstaller Installer, StagedUpdate Update, bool Restart);

    public void Dispose()
    {
        Program.PendingInstall = TakeInstall();
        _quit.Cancel();
        _refresh.Stop();
        _hideIndicator.Stop();
        _hotKeys.Dispose();
        _tray.Dispose();
        _http.Dispose();
    }

    private NativeMenu BuildMenu()
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
        _allow.Click += (_, _) => _agent.Control.SetAllow(!_agent.Control.AllowControl);
        _update.Click += (_, _) => RestartToUpdate();

        var menu = new NativeMenu();
        menu.Add(_status);
        menu.Add(new NativeMenuItemSeparator());
        menu.Add(_update);
        menu.Add(_updateLine);
        menu.Add(_share);
        menu.Add(_pause);
        menu.Add(_allow);
        menu.Add(new NativeMenuItemSeparator());
        menu.Add(Item("Open Anemo", OpenAnemo));
        menu.Add(Item("Settings…", ShowSettings));
        menu.Add(Item("Permissions…", ShowPermissions));
        menu.Add(Item("Command log", () => OpenInFinder(AppPaths.LogFolder)));
        menu.Add(new NativeMenuItemSeparator());
        menu.Add(Item("Quit Anemo Desktop", _quitApp));
        menu.NeedsUpdate += (_, _) => Refresh();
        return menu;
    }

    private static NativeMenuItem Item(string header, Action click)
    {
        var item = new NativeMenuItem(header);
        item.Click += (_, _) => click();
        return item;
    }

    private void RegisterHotKeys()
    {
        _hotKeys.UnregisterAll();
        var settings = _agent.Settings;
        var stop = Hotkey.Parse(settings.StopHotkey) ?? Hotkey.Parse(Hotkey.DefaultStop)!;
        var share = Hotkey.Parse(settings.ShareHotkey) ?? Hotkey.Parse(Hotkey.DefaultShare)!;
        if (!_hotKeys.Register(stop, () => _agent.Control.Stop()))
        {
            Notice.Show($"The stop key {MacKeyNames.Show(stop)} is used by another app. Choose another one in Settings.");
        }

        if (!_hotKeys.Register(share, () => _ = ShareAsync()))
        {
            Notice.Show($"The share key {MacKeyNames.Show(share)} is used by another app. Choose another one in Settings.");
        }
    }

    private void ApplyLoginItem()
    {
        try
        {
            if (!LoginItem.Set(_agent.Settings.StartWithWindows))
            {
                _log.Info("login item not changed");
            }
        }
        catch (Exception e)
        {
            _log.Info($"login item not changed: {e.GetType().Name}");
        }
    }

    private void OnStatus(ConnectionStatus status)
    {
        if (status.Phase == ConnectionPhase.Refused && status.Message is { } message)
        {
            Notice.Show(message);
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
        _tray.Icon = Icons.Tray(TrayStatus.Icon(status, _busy, _agent.Control));
        _tray.ToolTipText = TrayStatus.Tooltip(status, _busy, _agent.Control);
        var summary = TrayStatus.Summary(status, _busy, _agent.Control, _agent.Connection.Device);
        _status.Header = Permissions.AllGranted ? $"{summary.Title} · {summary.Detail}" : $"{summary.Title} · permissions missing";
        _allow.IsChecked = _agent.Control.AllowControl;
        _pause.Header = _agent.Control.PausedUntil is { } until
            ? $"Resume control (paused until {until.ToLocalTime():HH:mm})"
            : "Pause control for 1 hour";
        var updateItem = UpdateText.MenuItem(_agent.Updates.State);
        _update.IsVisible = _updateLine.IsVisible = updateItem is not null;
        _update.Header = updateItem ?? "";
        _settingsWindow?.ShowStatus(summary);
        _settingsWindow?.ShowUpdate(_agent.Updates.State, _agent.Settings.AutoUpdate);
    }

    /// <summary>The install after the app closed: the restart that was asked for, else a ready update (installed at quit).</summary>
    private Install? TakeInstall()
    {
        if (_restart is { } restart)
        {
            _restart = null;
            return restart;
        }

        return _agent.Updates.TakeReady() is { } ready ? new Install(_agent.Installer, ready, Restart: false) : null;
    }

    private void RestartToUpdate()
    {
        if (_agent.Updates.Note is { } note && _agent.Updates.Ready is not null)
        {
            Notice.Show(note); // ad hoc builds: the permissions have to be allowed again
        }

        _agent.Updates.RestartToUpdate();
    }

    /// <summary>"Restart to update" found nothing running: quit; Program swaps and restarts.</summary>
    private void QuitToInstall(StagedUpdate update)
    {
        _restart = new Install(_agent.Installer, update, Restart: true);
        _settingsWindow?.Close();
        _quitApp();
    }

    private async Task ShareAsync()
    {
        var result = await _agent.ShareScreenAsync(_quit.Token);
        Dispatcher.UIThread.Post(() => Notice.Show(result.Message));
    }

    private void ShowSettings()
    {
        if (_settingsWindow is not null)
        {
            _settingsWindow.Activate();
            return;
        }

        var window = new SettingsWindow(
            _agent.Settings,
            _agent.HasToken,
            _version,
            SaveSettings,
            () => _ = _agent.Updates.CheckNowAsync(_quit.Token),
            RestartToUpdate,
            _agent.Updates.Note);
        _settingsWindow = window;
        window.Closed += (_, _) => _settingsWindow = null;
        Refresh();
        window.Show();
        window.Activate();
    }

    /// <summary>Saves from the Settings window; a sentence when it failed (the window stays open).</summary>
    private string? SaveSettings(DesktopSettings settings, string? newToken)
    {
        try
        {
            _agent.Save(settings, newToken);
            RegisterHotKeys();
            ApplyLoginItem();
            Refresh();
            return null;
        }
        catch (SettingsSaveException e)
        {
            _log.Info($"settings not saved: {e.InnerException?.GetType().Name}");
            return e.Message;
        }
    }

    private void ShowPermissions()
    {
        if (_permissionsWindow is not null)
        {
            _permissionsWindow.Activate();
            return;
        }

        var window = new PermissionsWindow();
        _permissionsWindow = window;
        window.Closed += (_, _) =>
        {
            _permissionsWindow = null;
            Refresh();
        };
        window.Show();
        window.Activate();
    }

    /// <summary>A command needed a missing permission: show the window, at most every 10 minutes.</summary>
    private void NagAboutPermissions()
    {
        if (DateTimeOffset.UtcNow - _lastNag < PermissionNagEvery)
        {
            return;
        }

        _lastNag = DateTimeOffset.UtcNow;
        ShowPermissions();
    }

    private void OpenAnemo()
    {
        if (AnemoAddress.Parse(_agent.Settings.Address) is { } address)
        {
            Open(address.BaseUri.AbsoluteUri);
        }
        else
        {
            ShowSettings();
        }
    }

    private static void OpenInFinder(string folder)
    {
        Directory.CreateDirectory(folder);
        Open(folder);
    }

    private static void Open(string target)
    {
        var info = new ProcessStartInfo("/usr/bin/open") { UseShellExecute = false };
        info.ArgumentList.Add(target);
        using var _ = Process.Start(info);
    }
}
