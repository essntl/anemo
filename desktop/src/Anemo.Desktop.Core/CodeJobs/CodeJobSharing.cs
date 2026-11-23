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

    public CodeJobSharing(
        Func<DesktopSettings> settings,
        CodeJobStore store,
        IProcessProbe probe,
        TimeProvider time,
        IDiagnosticLog log,
        CodeJobsOptions? options = null)
    {
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
        if (CodeWire.Ack(msg) is { } ack)
        {
            Session?.OnAck(ack.JobId, ack.Seq);
        }
    }

    public async Task RunAsync(ICodeJobsLink link, DeviceInfo device, CancellationToken ct)
    {
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
                lock (_lock)
                {
                    _session = null;
                    _sessionCts = null;
                    _sessionFor = null;
                }
            }
        }
    }

    private Task Reset()
    {
        _changed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        return _changed.Task;
    }

    private static (bool Share, string Folder) Wanted(DesktopSettings settings) =>
        (settings.ShareCodeJobs, string.IsNullOrWhiteSpace(settings.CodeJobsFolder) ? CodeJobLimits.DefaultFolder : settings.CodeJobsFolder.Trim());
}
