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
using Anemo.Desktop.Platform;

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
    private bool _busy;
    private SettingsForm? _settingsForm;

    public TrayApp()
    {
        _ui.CreateControl();
        var time = TimeProvider.System;
        _log = new DiagnosticLog(AppPaths.LogFolder, time);
        var version = typeof(TrayApp).Assembly.GetName().Version?.ToString(3) ?? "1.0.0";
        _agent = new DesktopAgent(new DesktopAgentParts(
            new SettingsStore(AppPaths.SettingsFile, new DpapiProtector()),
            new PlatformServices(new WindowsDesktop(), new SendInputDevice(), new WindowsClipboard(), new StartMenuLauncher(), new PowerShellHost()),
            new CommandLog(AppPaths.LogFolder, time),
            _log,
            time,
            _http,
            version,
            AppPaths.DefaultWorkFolder,
            Processes: new WindowsProcessProbe()));

        _indicator = new Indicator(() => _agent.Control.Stop());
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
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _quit.Cancel();
            _tray.Visible = false;
            _tray.Dispose();
            _hotkeys.Dispose();
            _indicator.Dispose();
            _icons.Dispose();
            _hideIndicator.Dispose();
            _refresh.Dispose();
            _http.Dispose();
            _ui.Dispose();
        }

        base.Dispose(disposing);
    }

    private void BuildMenu()
    {
        var menu = new ContextMenuStrip();
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
        menu.Items.Add(_share);
        menu.Items.Add(_pause);
        menu.Items.Add(_allow);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Open Anemo", null, (_, _) => OpenAnemo());
        menu.Items.Add("Settings…", null, (_, _) => ShowSettings());
        menu.Items.Add("Command log", null, (_, _) => OpenFolder(AppPaths.LogFolder));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quit", null, (_, _) => ExitThread());
        menu.Opening += (_, _) => Refresh();
        _tray.ContextMenuStrip = menu;
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
        _tray.Icon = _icons.For(TrayStatus.Icon(status, _busy));
        _tray.Text = TrayStatus.Tooltip(status, _busy, _agent.Control);
        _allow.Checked = _agent.Control.AllowControl;
        _pause.Text = _agent.Control.PausedUntil is { } until
            ? $"Resume control (paused until {until.ToLocalTime():HH:mm})"
            : "Pause control for 1 hour";
    }

    private async Task ShareAsync()
    {
        var result = await _agent.ShareScreenAsync(_quit.Token);
        OnUi(() => Balloon(result.Message, result.Ok ? ToolTipIcon.Info : ToolTipIcon.Warning));
    }

    private void ShowSettings()
    {
        if (_settingsForm is not null)
        {
            _settingsForm.Activate();
            return;
        }

        var device = _agent.Connection.Device;
        var status = TrayStatus.Tooltip(_agent.Connection.Status, _busy, _agent.Control).Replace("Anemo Desktop: ", "")
            + (device is null ? "" : $"\nThis computer is “{device.Name}” in Anemo ({device.Trust}).");
        using var form = new SettingsForm(_agent.Settings, _agent.HasToken, status, AppPaths.DefaultWorkFolder, SaveSettings);
        _settingsForm = form;
        try
        {
            if (form.ShowDialog() == DialogResult.OK)
            {
                RegisterHotkeys();
                ApplyStartup();
                Refresh();
            }
        }
        finally
        {
            _settingsForm = null;
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
