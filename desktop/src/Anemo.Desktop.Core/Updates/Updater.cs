using System.Security.Cryptography;
using Anemo.Desktop.Core.Storage;

namespace Anemo.Desktop.Core.Updates;

/// <summary>Where the updater is.</summary>
public enum UpdatePhase
{
    /// <summary>This copy can't update itself (see <see cref="UpdateState.Message"/>).</summary>
    Unavailable,

    /// <summary>Not checked yet.</summary>
    Idle,

    Checking,

    UpToDate,

    Downloading,

    /// <summary>Downloaded and checked: installed at quit, or now with "Restart to update".</summary>
    Ready,

    /// <summary>"Restart to update" was chosen; waiting until the agent is done.</summary>
    WaitingToRestart,

    /// <summary>The last check or download failed (see <see cref="UpdateState.Message"/>).</summary>
    Failed,
}

/// <param name="Version">The update's version (Downloading, Ready, WaitingToRestart).</param>
/// <param name="Message">Why (Unavailable, Failed), or what the restart waits for (WaitingToRestart).</param>
/// <param name="CheckedAt">When GitHub last answered.</param>
public sealed record UpdateState(UpdatePhase Phase, AppVersion? Version = null, string? Message = null, DateTimeOffset? CheckedAt = null);

public sealed class UpdateOptions
{
    /// <summary>The repository whose Releases hold the client (compiled in from release.yml; see Directory.Build.props).</summary>
    public string Repository { get; init; } = "essntl/anemo";

    /// <summary>
    /// The release signing key (base64 SubjectPublicKeyInfo, ECDSA P-256), compiled in when the
    /// repository has one. With a key, an unsigned or wrongly signed release is refused; without,
    /// only the checksum is checked.
    /// </summary>
    public string? PublicKey { get; init; }

    /// <summary>The first check, a little after start (the connection comes first).</summary>
    public TimeSpan FirstCheck { get; init; } = TimeSpan.FromMinutes(1);

    public TimeSpan Every { get; init; } = TimeSpan.FromHours(6);

    /// <summary>After GitHub couldn't be reached.</summary>
    public TimeSpan RetryAfterFailure { get; init; } = TimeSpan.FromHours(1);

    /// <summary>The exes are about 80 MB, the macOS zip about 45 MB.</summary>
    public long MaxDownloadBytes { get; init; } = 400L * 1024 * 1024;

    /// <summary>How often the loop looks at the clock (and, while waiting to restart, whether the agent is done).</summary>
    public TimeSpan Tick { get; init; } = TimeSpan.FromSeconds(5);

    /// <summary>The repository and key compiled into the app (Directory.Build.props, from release.yml).</summary>
    public static UpdateOptions FromBuild(System.Reflection.Assembly app)
    {
        string? Read(string key) => app.GetCustomAttributes(typeof(System.Reflection.AssemblyMetadataAttribute), false)
            .Cast<System.Reflection.AssemblyMetadataAttribute>()
            .FirstOrDefault(a => a.Key == key)?.Value is { Length: > 0 } value ? value.Trim() : null;

        var repository = Read("AnemoUpdateRepository");
        return new UpdateOptions
        {
            Repository = repository is not null && GitHubReleaseFeed.IsRepository(repository) ? repository : new UpdateOptions().Repository,
            PublicKey = Read("AnemoUpdatePublicKey"),
        };
    }
}

/// <summary>
/// Anemo Desktop's updates (docs/specs/23-desktop-auto-update.md): checks GitHub Releases on
/// start and every 6 hours while "Update automatically" is on (or when asked), downloads the
/// newest stable <c>desktop-v</c> release for this computer, checks it (signature when the
/// build has a key, SHA-256 from the release's checksum file, then the platform's checks) and
/// keeps it ready. The host installs it at quit (<see cref="Ready"/>) or, after
/// <see cref="RestartToUpdate"/>, once nothing is running (<see cref="RestartRequested"/>).
/// </summary>
public sealed class Updater
{
    private readonly Func<DesktopSettings> _settings;
    private readonly IUpdatePlatform _platform;
    private readonly IReleaseFeed _feed;
    private readonly UpdateInstaller _installer;
    private readonly AppVersion? _current;
    private readonly UpdateOptions _options;
    private readonly TimeProvider _time;
    private readonly IDiagnosticLog _log;
    private readonly Func<string?> _busy;
    private readonly SemaphoreSlim _checking = new(1, 1);
    private readonly object _lock = new();
    private UpdateState _state;
    private StagedUpdate? _ready;
    private bool _readyAsked;
    private bool _restartRaised;
    private DateTimeOffset _nextCheck;
    private DateTimeOffset? _checkedAt;
    private string? _etag;
    private string? _releases;

    /// <param name="busy">Why now is a bad moment to restart (a command, a copy, a Claude Code job), or null when idle.</param>
    public Updater(
        Func<DesktopSettings> settings,
        IUpdatePlatform platform,
        IReleaseFeed feed,
        UpdateInstaller installer,
        string currentVersion,
        UpdateOptions options,
        TimeProvider time,
        IDiagnosticLog log,
        Func<string?> busy)
    {
        _settings = settings;
        _platform = platform;
        _feed = feed;
        _installer = installer;
        _current = AppVersion.Parse(currentVersion);
        _options = options;
        _time = time;
        _log = log;
        _busy = busy;
        _nextCheck = time.GetUtcNow() + options.FirstCheck;
        var unavailable = _current is null ? "This copy's version isn't a release version, so it doesn't update itself." : platform.Unavailable;
        if (unavailable is null && options.PublicKey is { } key && !UpdateSignature.IsKey(key))
        {
            unavailable = "This build's update key is damaged, so it doesn't update itself. Download a new copy from GitHub.";
        }

        _state = unavailable is null ? new UpdateState(UpdatePhase.Idle) : new UpdateState(UpdatePhase.Unavailable, Message: unavailable);
    }

    /// <summary>Raised (on any thread) whenever <see cref="State"/> changes.</summary>
    public event Action? Changed;

    /// <summary>Raised once, on the updater's thread, when a restart was asked for and nothing is running any more: quit and install.</summary>
    public event Action<StagedUpdate>? RestartRequested;

    public UpdateState State
    {
        get
        {
            lock (_lock)
            {
                return _state;
            }
        }
    }

    /// <summary>The update to install at quit, if one is ready.</summary>
    public StagedUpdate? Ready
    {
        get
        {
            lock (_lock)
            {
                return _ready;
            }
        }
    }

    /// <summary>A sentence for before installing (macOS ad hoc builds), or null.</summary>
    public string? Note => _platform.Note;

    public bool Available => State.Phase != UpdatePhase.Unavailable;

    /// <summary>Checks on start (after <see cref="UpdateOptions.FirstCheck"/>) and every 6 hours until cancelled.</summary>
    public async Task RunAsync(CancellationToken ct)
    {
        if (!Available)
        {
            return;
        }

        try
        {
            _platform.CleanUp();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            _log.Info($"update: leftovers not removed: {e.GetType().Name}");
        }

        try
        {
            while (true)
            {
                try
                {
                    await TickAsync(ct);
                }
                catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
                {
                    // Whatever went wrong, the loop goes on: updates must not stop until a restart.
                    _log.Info($"update: unexpected error in the update loop: {e.GetType().Name}");
                }

                await Task.Delay(_options.Tick, _time, ct);
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
        }
    }

    /// <summary>One look: a due check, a ready update the setting no longer wants, a restart that can happen now.</summary>
    public async Task TickAsync(CancellationToken ct)
    {
        if (!Available)
        {
            return;
        }

        var auto = _settings().AutoUpdate;
        if (!auto)
        {
            DiscardIfNotAsked();
        }

        if (State.Phase == UpdatePhase.WaitingToRestart)
        {
            TryRestart();
            return;
        }

        if (auto && _time.GetUtcNow() >= _nextCheck)
        {
            await CheckAsync(asked: false, ct);
        }
    }

    /// <summary>"Check now": checks (and downloads) even with automatic updates off.</summary>
    public Task CheckNowAsync(CancellationToken ct) => Available ? CheckAsync(asked: true, ct) : Task.CompletedTask;

    /// <summary>"Restart to update": restarts as soon as nothing is running. False when no update is ready.</summary>
    public bool RestartToUpdate()
    {
        lock (_lock)
        {
            if (_ready is null)
            {
                return false;
            }

            _restartRaised = false;
        }

        TryRestart();
        return true;
    }

    /// <summary>The restarted copy (started with <c>--updated</c>) tells the old one it is up.</summary>
    public void ReportStarted()
    {
        if (_current is { } version)
        {
            _installer.ReportStarted(version);
        }
    }

    /// <summary>Takes the ready update for the install at quit (so it is installed once).</summary>
    public StagedUpdate? TakeReady()
    {
        lock (_lock)
        {
            var ready = _ready;
            _ready = null;
            return ready;
        }
    }

    private void TryRestart()
    {
        StagedUpdate? ready;
        var reason = _busy();
        lock (_lock)
        {
            ready = _ready;
            if (ready is null)
            {
                return;
            }

            if (reason is not null || _restartRaised)
            {
                SetLocked(new UpdateState(UpdatePhase.WaitingToRestart, ready.Version, reason, _checkedAt));
                return;
            }

            _restartRaised = true;
            SetLocked(new UpdateState(UpdatePhase.WaitingToRestart, ready.Version, null, _checkedAt));
        }

        _log.Info($"update {ready.Version}: restarting to install");
        RestartRequested?.Invoke(ready);
    }

    private void DiscardIfNotAsked()
    {
        StagedUpdate? discard;
        lock (_lock)
        {
            if (_ready is null || _readyAsked)
            {
                return;
            }

            discard = _ready;
            _ready = null;
            SetLocked(new UpdateState(UpdatePhase.Idle, CheckedAt: _checkedAt));
        }

        _log.Info($"update {discard.Version}: discarded (automatic updates switched off)");
        DeleteStaged(discard);
    }

    private async Task CheckAsync(bool asked, CancellationToken ct)
    {
        if (!await _checking.WaitAsync(0, ct))
        {
            return; // one at a time; the running one answers
        }

        try
        {
            await CheckLockedAsync(asked, ct);
        }
        finally
        {
            _checking.Release();
        }
    }

    private async Task CheckLockedAsync(bool asked, CancellationToken ct)
    {
        var current = _current!.Value;
        if (Ready is null)
        {
            Set(new UpdateState(UpdatePhase.Checking, CheckedAt: _checkedAt));
        }

        try
        {
            var candidate = ReleaseSelection.Pick(await ReleasesAsync(ct), current, _platform.AssetName, _platform.ChecksumsName);
            var now = _time.GetUtcNow();
            _checkedAt = now;
            _nextCheck = now + _options.Every;
            var ready = Ready;
            if (candidate is null || (ready is not null && candidate.Version <= ready.Version))
            {
                if (ready is not null)
                {
                    lock (_lock)
                    {
                        _readyAsked |= asked;
                    }
                }

                Set(ready is null ? new UpdateState(UpdatePhase.UpToDate, CheckedAt: now) : State with { CheckedAt = now });
                return;
            }

            if (!asked && _installer.FailedVersion() == candidate.Version)
            {
                Set(new UpdateState(
                    UpdatePhase.Failed,
                    candidate.Version,
                    $"{candidate.Version} didn't start after the last update, so it isn't installed by itself. Check now tries again.",
                    now));
                return;
            }

            await DownloadAsync(candidate, asked, ct);
        }
        catch (UpdateRefusedException e)
        {
            Fail(e.Message, _options.Every);
        }
        catch (ReleaseFeedException e)
        {
            Fail(e.Message, _options.RetryAfterFailure);
        }
        catch (Exception e) when (e is HttpRequestException)
        {
            Fail("GitHub couldn't be reached.", _options.RetryAfterFailure);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            Fail("GitHub took too long to answer.", _options.RetryAfterFailure);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            _log.Info($"update: file error: {e.GetType().Name}");
            Fail("The update couldn't be saved on this computer.", _options.RetryAfterFailure);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            // Anything else (an antivirus refusing to start the self-test, a process that can't be
            // ended, a bug): this attempt fails and the next one comes as after a network error,
            // rather than the state staying "Downloading" until a restart.
            _log.Info($"update: unexpected error: {e.GetType().Name}");
            Fail("The update failed unexpectedly; it is tried again later.", _options.RetryAfterFailure);
        }
    }

    private async Task<string> ReleasesAsync(CancellationToken ct)
    {
        var response = await _feed.GetReleasesAsync(_releases is null ? null : _etag, ct);
        if (response.NotModified && _releases is not null)
        {
            return _releases;
        }

        if (response.NotModified)
        {
            response = await _feed.GetReleasesAsync(null, ct);
        }

        _releases = response.Body ?? throw new UpdateRefusedException("GitHub's list of releases couldn't be read.");
        _etag = response.ETag;
        return _releases;
    }

    private async Task DownloadAsync(UpdateCandidate candidate, bool asked, CancellationToken ct)
    {
        if (_options.PublicKey is not null && !candidate.HasSignature)
        {
            throw new UpdateRefusedException($"{candidate.Version} isn't signed with the release key, so it isn't installed.");
        }

        _log.Info($"update {candidate.Version}: downloading {candidate.Asset}");
        Set(new UpdateState(UpdatePhase.Downloading, candidate.Version, CheckedAt: _checkedAt));
        var checksums = await _feed.GetSmallAssetAsync(candidate.Tag, candidate.Checksums, Checksums.MaxBytes, ct);
        if (_options.PublicKey is { } key)
        {
            var signature = await _feed.GetSmallAssetAsync(candidate.Tag, candidate.Checksums + UpdateSignature.Suffix, UpdateSignature.MaxBytes, ct);
            if (!UpdateSignature.Verify(key, candidate.Tag, checksums, signature))
            {
                throw new UpdateRefusedException($"{candidate.Version}'s signature doesn't match the release key, so it isn't installed.");
            }
        }

        var expected = Checksums.For(checksums, candidate.Asset);
        var path = _platform.DownloadPath;
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        try
        {
            await using (var file = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                await _feed.DownloadAssetAsync(candidate.Tag, candidate.Asset, file, _options.MaxDownloadBytes, ct);
            }

            byte[] actual;
            await using (var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                actual = await SHA256.HashDataAsync(file, ct);
            }

            if (!Checksums.Same(expected, actual))
            {
                _log.Info($"update {candidate.Version}: checksum mismatch; download deleted");
                throw new UpdateRefusedException($"The download of {candidate.Version} didn't match the release's checksum, so it was deleted and not installed.");
            }

            var old = TakeReady();
            if (old is not null)
            {
                DeleteStaged(old);
            }

            var staged = await _platform.PrepareAsync(path, candidate.Version, ct);
            lock (_lock)
            {
                _ready = staged;
                _readyAsked = asked;
                SetLocked(new UpdateState(UpdatePhase.Ready, candidate.Version, CheckedAt: _checkedAt));
            }

            _log.Info($"update {candidate.Version}: ready");
        }
        finally
        {
            TryDelete(path); // PrepareAsync moved it if it was good; anything left is a half or a refused download
        }
    }

    private void Fail(string message, TimeSpan retry)
    {
        _nextCheck = _time.GetUtcNow() + retry;
        _log.Info($"update: {message}");
        // A newer version that failed doesn't take away the one that is ready.
        Set(Ready is { } ready
            ? new UpdateState(UpdatePhase.Ready, ready.Version, CheckedAt: _checkedAt)
            : new UpdateState(UpdatePhase.Failed, Message: message, CheckedAt: _checkedAt));
    }

    private void DeleteStaged(StagedUpdate staged) => TryDelete(staged.Paths.Staged);

    private void TryDelete(string path)
    {
        try
        {
            _platform.Files.Delete(path);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            _log.Info($"update: {Path.GetFileName(path)} not deleted: {e.GetType().Name}");
        }
    }

    private void Set(UpdateState state)
    {
        lock (_lock)
        {
            SetLocked(state);
        }
    }

    private void SetLocked(UpdateState state)
    {
        if (state == _state)
        {
            return;
        }

        _state = state;
        ThreadPool.QueueUserWorkItem(_ => Changed?.Invoke());
    }
}
