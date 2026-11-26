using Anemo.Desktop.Core.CodeJobs;
using Anemo.Desktop.Core.Commands;
using Anemo.Desktop.Core.Connection;
using Anemo.Desktop.Core.Control;
using Anemo.Desktop.Core.Files;
using Anemo.Desktop.Core.Platform;
using Anemo.Desktop.Core.SharedScreen;
using Anemo.Desktop.Core.Storage;
using Anemo.Desktop.Core.Updates;

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
    DesktopPlatform? TargetSystem = null,
    string? HomeFolder = null,
    IUpdatePlatform? Updates = null,
    IReleaseFeed? ReleaseFeed = null,
    UpdateOptions? UpdateOptions = null)
{
    /// <summary>The system the client runs on (Windows unless the host says otherwise).</summary>
    public DesktopPlatform Os => TargetSystem ?? DesktopPlatform.Windows;

    /// <summary>The Claude Code jobs' state file, beside <c>settings.json</c>.</summary>
    public string CodeJobsStateFile => Path.Combine(Path.GetDirectoryName(Store.Path) ?? ".", "code-jobs.json");

    /// <summary>The cache of remote repositories for the git reads (device-contracts.md §7.6), beside <c>settings.json</c>, never in the projects folder.</summary>
    public string GitCacheFolder => Path.Combine(Path.GetDirectoryName(Store.Path) ?? ".", "git-cache");

    /// <summary>The folder of <c>settings.json</c>: the file actions never read or write in it (§8.2).</summary>
    public string DataFolder => Path.GetDirectoryName(Path.GetFullPath(Store.Path)) ?? ".";

    /// <summary>The updater's marks (the started-file, the failed-file) and, on macOS, the download.</summary>
    public string UpdatesFolder => Path.Combine(DataFolder, "updates");
}

/// <summary>
/// The client without its window: settings, control state, the connection and the
/// command handlers wired together. The app adds the tray, the hotkeys and the indicator.
/// </summary>
public sealed class DesktopAgent
{
    /// <summary>
    /// A restart for an update waits this long after the agent's last command: an agent sends its
    /// commands one after another with the model thinking in between, and a restart in such a gap
    /// would still break its task.
    /// </summary>
    public static readonly TimeSpan QuietBeforeRestart = TimeSpan.FromSeconds(60);

    private readonly DesktopAgentParts _parts;
    private readonly CodeJobControl _codeControl;
    private readonly SharedScreenClient _sharedScreen;
    private readonly object _lock = new();

    /// <summary>The shell's kind for the offer, looked up once (installing pwsh needs a restart to show).</summary>
    private readonly Lazy<string> _shellKind;
    private DesktopSettings _settings;
    private string? _runningAction;
    private DateTimeOffset? _lastCommandEnded;

    public DesktopAgent(DesktopAgentParts parts)
    {
        _parts = parts;
        _settings = parts.Store.Load();
        _shellKind = new Lazy<string>(() =>
            parts.Platform.Shell.FindShell()?.Kind ?? (parts.Os.IsMac ? ShellKinds.Zsh : ShellKinds.PowerShell));
        StartupProblem = parts.Store.LoadProblem;
        if (StartupProblem is not null)
        {
            parts.Log.Info("settings file unreadable; control starts off");
        }
        Control = new ControlState(parts.Time, _settings.AllowControl, _settings.PausedUntil);
        Control.Changed += SaveControlState;
        Files = new DeviceFiles(() => Settings, parts.Time, parts.Os, parts.HomeFolder, parts.DataFolder);
        _codeControl = new CodeJobControl(
            () => Settings,
            parts.CodeHost ?? NoCodeHost.Instance,
            parts.Processes ?? NoProcesses.Instance,
            parts.Time,
            parts.CodeJobControlOptions,
            parts.Os,
            parts.GitCacheFolder);
        Processor = new CommandProcessor(
            parts.Platform,
            Control,
            () => Settings,
            parts.CommandLog,
            WithWorkFolder(parts.CommandOptions ?? new CommandOptions(), parts.DefaultWorkFolder, parts.Os),
            _codeControl,
            Files);
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
            CodeJobs,
            parts.Os.WireName,
            () => _shellKind.Value,
            Files.Offered);
        _sharedScreen = new SharedScreenClient(parts.Http);
        Connection.CommandRunning += OnCommandRunning;

        var updates = parts.Updates ?? NoUpdatePlatform.Instance;
        var updateOptions = parts.UpdateOptions ?? new UpdateOptions();
        Installer = new UpdateInstaller(
            updates.Files, updates is NoUpdatePlatform ? NoLauncher.Instance : updates.Launcher, parts.Log, parts.UpdatesFolder);
        Updates = new Updater(
            () => Settings,
            updates,
            parts.ReleaseFeed ?? (updates.Unavailable is null ? new GitHubReleaseFeed(updateOptions.Repository, parts.Version) : NoReleaseFeed.Instance),
            Installer,
            parts.Version,
            updateOptions,
            parts.Time,
            parts.Log,
            BusyReason);
    }

    public ControlState Control { get; }

    public DeviceConnection Connection { get; }

    public CommandProcessor Processor { get; }

    /// <summary>"Let Anemo read and write files" (device-contracts.md §8).</summary>
    public DeviceFiles Files { get; }

    /// <summary>"Share Claude Code jobs with Anemo".</summary>
    public CodeJobSharing CodeJobs { get; }

    /// <summary>Updates of Anemo Desktop itself (docs/specs/23-desktop-auto-update.md).</summary>
    public Updater Updates { get; }

    /// <summary>Swaps a ready update in, at quit (the host calls it once its window and lock are gone).</summary>
    public UpdateInstaller Installer { get; }

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
        return Task.WhenAll(Connection.RunAsync(ct), Updates.RunAsync(ct));
    }

    /// <summary>
    /// Why a restart for an update has to wait, as a few words, or null when nothing is running:
    /// a command (and the minute after it), a file copy, a Claude Code job being set up (its clone
    /// runs in this process) or one that is running (sharing would stop until the restart).
    /// </summary>
    public string? BusyReason()
    {
        string? running;
        DateTimeOffset? ended;
        lock (_lock)
        {
            running = _runningAction;
            ended = _lastCommandEnded;
        }

        if (running is not null)
        {
            return "the agent is using this computer";
        }

        if (ended is { } at && _parts.Time.GetUtcNow() - at < QuietBeforeRestart)
        {
            return "the agent used this computer a moment ago";
        }

        if (Files.OpenTransfers > 0)
        {
            return "a file is being copied";
        }

        if (_codeControl.StartingCount > 0)
        {
            return "a Claude Code job is being set up";
        }

        return CodeJobs.Session?.FollowingCount > 0 ? "a Claude Code job is running" : null;
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
            || old.StartCodeJobs != settings.StartCodeJobs || old.ShareFiles != settings.ShareFiles)
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

    private void OnCommandRunning(string? action)
    {
        lock (_lock)
        {
            if (action is null && _runningAction is not null)
            {
                _lastCommandEnded = _parts.Time.GetUtcNow();
            }

            _runningAction = action;
        }
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
