using Anemo.Desktop.Core.Commands;
using Anemo.Desktop.Core.Connection;
using Anemo.Desktop.Core.Control;
using Anemo.Desktop.Core.Platform;
using Anemo.Desktop.Core.SharedScreen;
using Anemo.Desktop.Core.Storage;

namespace Anemo.Desktop.Core;

/// <summary>Everything the agent needs from outside: where files go, the platform, the clock.</summary>
public sealed record DesktopAgentParts(
    SettingsStore Store,
    PlatformServices Platform,
    CommandLog CommandLog,
    IDiagnosticLog Log,
    TimeProvider Time,
    HttpClient Http,
    string Version,
    string DefaultWorkFolder,
    DeviceConnectionOptions? ConnectionOptions = null,
    CommandOptions? CommandOptions = null);

/// <summary>
/// The client without its window: settings, control state, the connection and the
/// command handlers wired together. The app adds the tray, the hotkeys and the indicator.
/// </summary>
public sealed class DesktopAgent
{
    private readonly DesktopAgentParts _parts;
    private readonly SharedScreenClient _sharedScreen;
    private readonly object _lock = new();
    private DesktopSettings _settings;

    public DesktopAgent(DesktopAgentParts parts)
    {
        _parts = parts;
        _settings = parts.Store.Load();
        Control = new ControlState(parts.Time, _settings.AllowControl, _settings.PausedUntil);
        Control.Changed += SaveControlState;
        Processor = new CommandProcessor(
            parts.Platform,
            Control,
            () => Settings,
            parts.CommandLog,
            parts.CommandOptions ?? new CommandOptions { DefaultWorkFolder = parts.DefaultWorkFolder });
        Connection = new DeviceConnection(
            ConnectionSettings,
            Control,
            () => Settings.PowerShellEnabled,
            Processor,
            parts.Log,
            parts.Version,
            parts.ConnectionOptions);
        _sharedScreen = new SharedScreenClient(parts.Http);
    }

    public ControlState Control { get; }

    public DeviceConnection Connection { get; }

    public CommandProcessor Processor { get; }

    public DesktopSettings Settings
    {
        get
        {
            lock (_lock)
            {
                return _settings;
            }
        }
    }

    public bool HasToken => ConnectionSettings() is not null;

    public Task RunAsync(CancellationToken ct)
    {
        _parts.CommandLog.Prune();
        return Connection.RunAsync(ct);
    }

    /// <summary>
    /// Saves new settings from the Settings window. <paramref name="newToken"/> null keeps
    /// the saved token. Reconnects when the address or token changed.
    /// </summary>
    public void Save(DesktopSettings settings, string? newToken)
    {
        DesktopSettings old;
        lock (_lock)
        {
            old = _settings;
            var updated = newToken is null ? settings with { ProtectedToken = old.ProtectedToken } : _parts.Store.WithToken(settings, newToken);
            _settings = updated with { AllowControl = Control.AllowControl, PausedUntil = Control.PausedUntil };
            _parts.Store.Save(_settings);
        }

        if (old.Address != settings.Address || newToken is not null)
        {
            Connection.Reconnect();
        }
        else if (old.PowerShellEnabled != settings.PowerShellEnabled)
        {
            Connection.OfferNow();
        }
    }

    /// <summary>"Share this screen with Anemo" (menu or hotkey).</summary>
    public async Task<ShareResult> ShareScreenAsync(CancellationToken ct)
    {
        var settings = ConnectionSettings();
        if (settings is null)
        {
            return new ShareResult(false, "Set the Anemo address and token in Settings first.");
        }

        SharedScreenContent content;
        try
        {
            content = await Task.Run(() => SharedScreenClient.Capture(_parts.Platform.Desktop, ct), ct);
        }
        catch (CommandException e)
        {
            return new ShareResult(false, e.Message);
        }

        var result = await _sharedScreen.ShareAsync(settings, content, ct);
        _parts.Log.Info(result.Ok ? "screen shared" : "screen not shared");
        return result;
    }

    private ConnectionSettings? ConnectionSettings()
    {
        var settings = Settings;
        var address = AnemoAddress.Parse(settings.Address);
        var token = _parts.Store.Token(settings);
        return address is null || string.IsNullOrWhiteSpace(token) ? null : new ConnectionSettings(address, token);
    }

    private void SaveControlState()
    {
        lock (_lock)
        {
            _settings = _settings with { AllowControl = Control.AllowControl, PausedUntil = Control.PausedUntil };
            _parts.Store.Save(_settings);
        }
    }
}
