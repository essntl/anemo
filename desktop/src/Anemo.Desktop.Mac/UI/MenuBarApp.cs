using System.Diagnostics;
using Anemo.Desktop.Core;
using TrayIcon = Avalonia.Controls.TrayIcon;
using Anemo.Desktop.Core.Connection;
using Anemo.Desktop.Core.Control;
using Anemo.Desktop.Core.Platform;
using Anemo.Desktop.Core.Storage;
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
    private readonly string _version;
    private bool _busy;
    private DateTimeOffset _lastNag = DateTimeOffset.MinValue;
    private SettingsWindow? _settingsWindow;
    private PermissionsWindow? _permissionsWindow;

    public MenuBarApp(Application app, Action quit)
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
            TargetSystem: DesktopPlatform.MacOS(AppPaths.HomeFolder)));

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
    }

    public void Dispose()
    {
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

        var menu = new NativeMenu();
        menu.Add(_status);
        menu.Add(new NativeMenuItemSeparator());
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
        _settingsWindow?.ShowStatus(summary);
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

        var window = new SettingsWindow(_agent.Settings, _agent.HasToken, _version, SaveSettings);
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
