using System.Text.Json.Nodes;
using Anemo.Desktop.Core.Connection;
using Anemo.Desktop.Core.Protocol;
using Anemo.Desktop.Core.Storage;

namespace Anemo.Desktop.Core.CodeJobs;

/// <summary>
/// "Share Claude Code jobs with Anemo" (code-sessions.md D4): while connected, trusted and
/// switched on, a <see cref="CodeJobsSession"/> shares the jobs folder; switching it off, or
/// to another folder, stops or restarts it without a reconnect.
/// </summary>
public sealed class CodeJobSharing : ICodeJobsHost
{
    private readonly Func<DesktopSettings> _settings;
    private readonly CodeJobStore _store;
    private readonly IProcessProbe _probe;
    private readonly TimeProvider _time;
    private readonly IDiagnosticLog _log;
    private readonly CodeJobsOptions _options;
    private readonly object _lock = new();
    private TaskCompletionSource _changed = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private CodeJobsSession? _session;
    private CancellationTokenSource? _sessionCts;
    private (bool Share, string Folder)? _sessionFor;

    /// <summary>
    /// Per job, acks still to come on this connection for messages of a session that was
    /// replaced (sharing switched off and on, another folder): dropped when they come.
    /// </summary>
    private readonly Dictionary<string, int> _stale = new(StringComparer.Ordinal);

    /// <summary>The jobs folder when Settings names none (the platform's).</summary>
    private readonly string _defaultFolder;

    public CodeJobSharing(
        Func<DesktopSettings> settings,
        CodeJobStore store,
        IProcessProbe probe,
        TimeProvider time,
        IDiagnosticLog log,
        CodeJobsOptions? options = null,
        string? defaultFolder = null)
    {
        _defaultFolder = defaultFolder ?? CodeJobLimits.DefaultFolder;
        _settings = settings;
        _store = store;
        _probe = probe;
        _time = time;
        _log = log;
        _options = options ?? new CodeJobsOptions();
        if (!settings().ShareCodeJobs)
        {
            _store.SetSharedSince(null);
        }
    }

    public CodeJobStore Store => _store;

    /// <summary>The session sharing right now, if any (for tests).</summary>
    public CodeJobsSession? Session
    {
        get
        {
            lock (_lock)
            {
                return _session;
            }
        }
    }

    public bool Offered(DeviceInfo device) => device.Trusted && _settings().ShareCodeJobs;

    public bool OfferedStart(DeviceInfo device) => Offered(device) && _settings().StartCodeJobs;

    /// <summary>
    /// The settings were saved. Switched off: sharing stops and the next switch-on back-fills
    /// again. Switched on or another folder: sharing (re)starts on the connection.
    /// </summary>
    public void SettingsChanged()
    {
        var now = Wanted(_settings());
        if (!now.Share)
        {
            _store.SetSharedSince(null);
        }

        lock (_lock)
        {
            if (_sessionFor is { } running && running != now)
            {
                _sessionCts?.Cancel();
            }

            _changed.TrySetResult();
        }
    }

    public void OnAck(JsonObject msg)
    {
        if (CodeWire.Ack(msg) is not { } ack)
        {
            return;
        }

        CodeJobsSession? session;
        lock (_lock)
        {
            if (_stale.TryGetValue(ack.JobId, out var left) && left > 0)
            {
                // The answer to an earlier session's message: not to the current one's.
                if (left == 1)
                {
                    _stale.Remove(ack.JobId);
                }
                else
                {
                    _stale[ack.JobId] = left - 1;
                }

                return;
            }

            session = _session;
        }

        session?.OnAck(ack.JobId, ack.Seq);
    }

    public async Task RunAsync(ICodeJobsLink link, DeviceInfo device, CancellationToken ct)
    {
        lock (_lock)
        {
            _stale.Clear(); // a new connection: nothing earlier is answered on it
        }

        while (!ct.IsCancellationRequested)
        {
            Task changed;
            lock (_lock)
            {
                changed = _changed.Task.IsCompleted ? Reset() : _changed.Task;
            }

            var wanted = Wanted(_settings());
            if (!device.Trusted || !wanted.Share)
            {
                await changed.WaitAsync(ct);
                continue;
            }

            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            var session = new CodeJobsSession(wanted.Folder, _store, _probe, _time, _log, _options, link.SendAsync);
            lock (_lock)
            {
                _session = session;
                _sessionCts = cts;
                _sessionFor = wanted;
            }

            try
            {
                switch (await session.RunAsync(cts.Token))
                {
                    case CodeJobsEnd.AckTimeout:
                        _log.Info("code jobs: no ack within 60 s; reconnecting");
                        link.Drop();
                        return;
                    case CodeJobsEnd.NeverAcked:
                        _log.Info("code jobs: Anemo doesn't answer code.job; not sharing on this connection");
                        await changed.WaitAsync(ct);
                        break;
                }
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                // The settings changed: go round with the new ones.
            }
            finally
            {
                // A scan that ran while sharing was being switched off may have set it again:
                // switched off, the next switch-on must back-fill again (SettingsChanged).
                if (!Wanted(_settings()).Share)
                {
                    _store.SetSharedSince(null);
                }

                lock (_lock)
                {
                    _session = null;
                    _sessionCts = null;
                    _sessionFor = null;
                    foreach (var (jobId, count) in session.Unanswered())
                    {
                        _stale[jobId] = _stale.GetValueOrDefault(jobId) + count;
                    }
                }
            }
        }
    }

    private Task Reset()
    {
        _changed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        return _changed.Task;
    }

    private (bool Share, string Folder) Wanted(DesktopSettings settings) =>
        (settings.ShareCodeJobs, string.IsNullOrWhiteSpace(settings.CodeJobsFolder) ? _defaultFolder : settings.CodeJobsFolder.Trim());
}
