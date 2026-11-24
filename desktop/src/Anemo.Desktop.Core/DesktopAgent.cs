using Anemo.Desktop.Core.CodeJobs;
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
    CommandOptions? CommandOptions = null,
    IProcessProbe? Processes = null,
    CodeJobsOptions? CodeJobsOptions = null,
    ICodeHost? CodeHost = null,
    CodeJobControlOptions? CodeJobControlOptions = null,
    DesktopPlatform? TargetSystem = null)
{
    /// <summary>The system the client runs on (Windows unless the host says otherwise).</summary>
    public DesktopPlatform Os => TargetSystem ?? DesktopPlatform.Windows;

    /// <summary>The Claude Code jobs' state file, beside <c>settings.json</c>.</summary>
    public string CodeJobsStateFile => Path.Combine(Path.GetDirectoryName(Store.Path) ?? ".", "code-jobs.json");
}

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
        StartupProblem = parts.Store.LoadProblem;
        if (StartupProblem is not null)
        {
            parts.Log.Info("settings file unreadable; control starts off");
        }
        Control = new ControlState(parts.Time, _settings.AllowControl, _settings.PausedUntil);
        Control.Changed += SaveControlState;
        Processor = new CommandProcessor(
            parts.Platform,
            Control,
            () => Settings,
            parts.CommandLog,
            WithWorkFolder(parts.CommandOptions ?? new CommandOptions(), parts.DefaultWorkFolder, parts.Os),
            new CodeJobControl(
                () => Settings,
                parts.CodeHost ?? NoCodeHost.Instance,
                parts.Processes ?? NoProcesses.Instance,
                parts.Time,
                parts.CodeJobControlOptions,
                parts.Os));
        CodeJobs = new CodeJobSharing(
            () => Settings,
            new CodeJobStore(parts.CodeJobsStateFile, parts.Time, parts.Log),
            parts.Processes ?? NoProcesses.Instance,
            parts.Time,
            parts.Log,
            parts.CodeJobsOptions,
            parts.Os.DefaultJobsFolder);
        Connection = new DeviceConnection(
            ConnectionSettings,
            Control,
            () => Settings.PowerShellEnabled,
            Processor,
            parts.Log,
            parts.Version,
            parts.ConnectionOptions,
            CodeJobs);
        _sharedScreen = new SharedScreenClient(parts.Http);
    }

    public ControlState Control { get; }

    public DeviceConnection Connection { get; }

    public CommandProcessor Processor { get; }

    /// <summary>"Share Claude Code jobs with Anemo".</summary>
    public CodeJobSharing CodeJobs { get; }

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

    /// <summary>A sentence for the tray when the settings file couldn't be read at start.</summary>
    public string? StartupProblem { get; }

    public Task RunAsync(CancellationToken ct)
    {
        _parts.CommandLog.Prune();
        return Connection.RunAsync(ct);
    }

    /// <summary>
    /// Saves new settings from the Settings window. <paramref name="newToken"/> null keeps
    /// the saved token. Reconnects when the address or token changed.
    /// </summary>
    /// <exception cref="SettingsSaveException">With a sentence for the Settings window.</exception>
    public void Save(DesktopSettings settings, string? newToken)
    {
        DesktopSettings old;
        lock (_lock)
        {
            old = _settings;
            var updated = newToken is null ? settings with { ProtectedToken = old.ProtectedToken } : _parts.Store.WithToken(settings, newToken);
            updated = updated with { AllowControl = Control.AllowControl, PausedUntil = Control.PausedUntil };
            _parts.Store.Save(updated); // throws SettingsSaveException: nothing changes then
            _settings = updated;
        }

        var codeChanged = old.ShareCodeJobs != settings.ShareCodeJobs || old.CodeJobsFolder != settings.CodeJobsFolder;
        if (codeChanged)
        {
            CodeJobs.SettingsChanged(); // starts or stops sharing on the open connection
        }

        if (old.Address != settings.Address || newToken is not null)
        {
            Connection.Reconnect();
        }
        else if (old.PowerShellEnabled != settings.PowerShellEnabled || old.ShareCodeJobs != settings.ShareCodeJobs
            || old.StartCodeJobs != settings.StartCodeJobs)
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
            content = await Task.Run(() => SharedScreenClient.Capture(_parts.Platform.Desktop, ct, _parts.Os), ct);
        }
        catch (CommandException e)
        {
            return new ShareResult(false, e.Message);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            _parts.Log.Info($"screen not read: {e.GetType().Name}");
            return new ShareResult(false, "The screen couldn't be read; it wasn't shared.");
        }

        var result = await _sharedScreen.ShareAsync(settings, content, ct);
        _parts.Log.Info(result.Ok ? "screen shared" : "screen not shared");
        return result;
    }

    private static CommandOptions WithWorkFolder(CommandOptions options, string folder, DesktopPlatform platform) => new()
    {
        SettleDelay = options.SettleDelay,
        OpenDelay = options.OpenDelay,
        DefaultWorkFolder = folder,
        Platform = platform,
    };

    private ConnectionSettings? ConnectionSettings()
    {
        var settings = Settings;
        var address = AnemoAddress.Parse(settings.Address);
        var token = _parts.Store.Token(settings);
        return address is null || string.IsNullOrWhiteSpace(token) ? null : new ConnectionSettings(address, token);
    }

    /// <summary>
    /// Keeps "Allow control" and the pause in the file. A file that can't be written is
    /// logged, never thrown: the stop has to happen whatever the disk does.
    /// </summary>
    private void SaveControlState()
    {
        lock (_lock)
        {
            _settings = _settings with { AllowControl = Control.AllowControl, PausedUntil = Control.PausedUntil };
            try
            {
                _parts.Store.Save(_settings);
            }
            catch (SettingsSaveException e)
            {
                _parts.Log.Info($"control state not saved: {e.InnerException?.GetType().Name}");
            }
        }
    }
}
