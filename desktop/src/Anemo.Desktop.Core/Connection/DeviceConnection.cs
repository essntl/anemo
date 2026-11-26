using System.Net.WebSockets;
using System.Text.Json.Nodes;
using Anemo.Desktop.Core.Control;
using Anemo.Desktop.Core.Protocol;
using Anemo.Desktop.Core.Storage;

namespace Anemo.Desktop.Core.Connection;

/// <summary>What a command is run with: the device's command handlers.</summary>
public interface ICommandExecutor
{
    /// <summary>
    /// Runs one command. Throws <see cref="OperationCanceledException"/> when the token is
    /// cancelled (the user stopped control, or the connection went away).
    /// </summary>
    Task<CommandOutcome> ExecuteAsync(JsonObject command, DeviceInfo device, CancellationToken ct);
}

/// <summary>Where to connect and with which token.</summary>
public sealed record ConnectionSettings(AnemoAddress Address, string Token);

public sealed class DeviceConnectionOptions
{
    public TimeSpan PingInterval { get; init; } = TimeSpan.FromSeconds(20);

    public TimeSpan OfferInterval { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary>Connecting and the <c>welcome</c> must take less than this.</summary>
    public TimeSpan WelcomeTimeout { get; init; } = TimeSpan.FromSeconds(15);

    /// <summary>Nothing heard from Anemo (not even a pong) for this long: reconnect.</summary>
    public TimeSpan SilenceTimeout { get; init; } = TimeSpan.FromSeconds(65);

    /// <summary>A connection that lasted this long resets the back-off.</summary>
    public TimeSpan StableAfter { get; init; } = TimeSpan.FromSeconds(30);

    public Func<Backoff> Backoff { get; init; } = Connection.Backoff.Default;

    /// <summary>
    /// The largest message taken from Anemo. A <c>code_start</c> with images (up to 10 MB of
    /// them, as base64) is the largest there is.
    /// </summary>
    public int MaxMessageBytes { get; init; } = 16 * 1024 * 1024;
}

/// <summary>
/// The client's one WebSocket to Anemo (device-contracts.md §2): hello, welcome, pings,
/// offers, commands one at a time in order, results, <c>device.stopped</c>, notices, and
/// reconnecting with back-off. Only connects out.
/// </summary>
public sealed class DeviceConnection
{
    private readonly Func<ConnectionSettings?> _settings;
    private readonly ControlState _control;
    private readonly Func<bool> _shellSwitchedOn;
    private readonly ICommandExecutor _executor;
    private readonly IDiagnosticLog _log;
    private readonly string _version;
    private readonly DeviceConnectionOptions _options;
    private readonly ICodeJobsHost? _codeJobs;
    private readonly string _platform; // hello.platform
    private readonly Func<string> _shellKind; // offer.shell_kind
    private readonly Func<DeviceInfo, bool> _filesOffered; // offer.files (§8)
    private readonly object _lock = new();
    private TaskCompletionSource _kick = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private bool _kicked;
    private CancellationTokenSource? _sessionCts;
    private Session? _session;
    private string? _cursor;
    private int _badHellos;

    /// <summary>How many 4400 closes in a row before the client stops retrying.</summary>
    private const int MaxBadHellos = 3;

    public DeviceConnection(
        Func<ConnectionSettings?> settings,
        ControlState control,
        Func<bool> shellSwitchedOn,
        ICommandExecutor executor,
        IDiagnosticLog log,
        string version,
        DeviceConnectionOptions? options = null,
        ICodeJobsHost? codeJobs = null,
        string platform = "windows",
        Func<string>? shellKind = null,
        Func<DeviceInfo, bool>? filesOffered = null)
    {
        _platform = platform;
        _filesOffered = filesOffered ?? (_ => false);
        _shellKind = shellKind ?? (() => "powershell");
        _settings = settings;
        _control = control;
        _shellSwitchedOn = shellSwitchedOn;
        _executor = executor;
        _log = log;
        _version = version;
        _options = options ?? new DeviceConnectionOptions();
        _codeJobs = codeJobs;
    }

    public event Action<ConnectionStatus>? StatusChanged;

    /// <summary>Anemo's <c>notice</c> (this client is older than it supports).</summary>
    public event Action<string>? NoticeReceived;

    /// <summary>A command started (its action) or ended (null).</summary>
    public event Action<string?>? CommandRunning;

    public ConnectionStatus Status { get; private set; } = new(ConnectionPhase.NotConfigured);

    /// <summary>The device from the last <c>welcome</c>, while connected.</summary>
    public DeviceInfo? Device { get; private set; }

    /// <summary>Connects and stays connected until the token is cancelled.</summary>
    public async Task RunAsync(CancellationToken ct)
    {
        var backoff = _options.Backoff();
        _control.StopRequested += OnStopRequested;
        _control.Changed += OnControlChanged;
        try
        {
            while (!ct.IsCancellationRequested)
            {
                var settings = _settings();
                if (settings is null)
                {
                    SetStatus(new ConnectionStatus(ConnectionPhase.NotConfigured));
                    await WaitAsync(Timeout.InfiniteTimeSpan, ct);
                    continue;
                }

                var end = await RunSessionAsync(settings, ct);
                if (ct.IsCancellationRequested)
                {
                    break;
                }

                if (end.Kicked)
                {
                    backoff.Reset();
                    _badHellos = 0;
                    continue;
                }

                // A 4400 can follow a hello that merely arrived late: retried a few times.
                var retryBadHello = end.CloseCode == CloseCodes.BadFirstMessage && ++_badHellos < MaxBadHellos;
                if (!retryBadHello && CloseCodes.FinalMessage(end.CloseCode) is { } final)
                {
                    SetStatus(new ConnectionStatus(ConnectionPhase.Refused, final));
                    await WaitAsync(Timeout.InfiniteTimeSpan, ct);
                    backoff.Reset();
                    _badHellos = 0;
                    continue;
                }

                if (end.Stable)
                {
                    backoff.Reset();
                }

                var delay = backoff.Next();
                SetStatus(new ConnectionStatus(ConnectionPhase.Waiting, "Not connected to Anemo; trying again."));
                _log.Info($"reconnecting in {delay.TotalSeconds:0.#} s");
                await WaitAsync(delay, ct);
            }
        }
        finally
        {
            _control.StopRequested -= OnStopRequested;
            _control.Changed -= OnControlChanged;
            Device = null;
        }
    }

    /// <summary>Drops the connection (if any) and connects again at once, e.g. after new settings.</summary>
    public void Reconnect()
    {
        lock (_lock)
        {
            _kicked = true;
            _sessionCts?.Cancel();
            _kick.TrySetResult();
        }
    }

    /// <summary>Sends an offer now (PowerShell switched on or off).</summary>
    public void OfferNow() => _ = _session?.SendOfferAsync();

    /// <summary>
    /// After a stop the offer goes out from the stop path, after the result and
    /// <c>device.stopped</c>, so the order on the wire is always result, stopped, offer.
    /// </summary>
    private void OnControlChanged()
    {
        if (_session is { StopPending: false } session)
        {
            _ = session.SendOfferAsync();
        }
    }

    private void OnStopRequested() => _ = _session?.StopAsync();

    private async Task WaitAsync(TimeSpan delay, CancellationToken ct)
    {
        Task kick;
        lock (_lock)
        {
            if (_kicked)
            {
                _kicked = false;
                return;
            }

            _kick = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            kick = _kick.Task;
        }

        try
        {
            await Task.WhenAny(kick, Task.Delay(delay, ct));
        }
        finally
        {
            lock (_lock)
            {
                _kicked = false;
            }
        }
    }

    private void SetStatus(ConnectionStatus status)
    {
        if (status == Status)
        {
            return;
        }

        Status = status;
        StatusChanged?.Invoke(status);
    }

    private async Task<SessionEnd> RunSessionAsync(ConnectionSettings settings, CancellationToken ct)
    {
        using var sessionCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        lock (_lock)
        {
            _kicked = false;
            _sessionCts = sessionCts;
        }

        SetStatus(new ConnectionStatus(ConnectionPhase.Connecting));
        using var ws = new ClientWebSocket();
        var started = DateTimeOffset.UtcNow;
        int? closeCode = null;
        Session? live = null;
        try
        {
            using (var connectCts = CancellationTokenSource.CreateLinkedTokenSource(sessionCts.Token))
            {
                connectCts.CancelAfter(_options.WelcomeTimeout);
                await ws.ConnectAsync(settings.Address.WebSocketUri, connectCts.Token);
                var session = new Session(this, ws, sessionCts.Token);
                await session.SendAsync(Wire.Hello(settings.Token, _version, _cursor, _platform));
                var welcome = await session.ReceiveWelcomeAsync(connectCts.Token);
                if (welcome is null)
                {
                    closeCode = (int?)ws.CloseStatus;
                    _log.Info($"no welcome (close {closeCode?.ToString() ?? "none"})");
                    return new SessionEnd(closeCode, Kicked(), false);
                }

                Device = welcome;
                _badHellos = 0;
                session.Device = welcome;
                live = session;
                _session = session;
                _log.Info($"connected as {welcome.Name} ({welcome.Trust})");
            }

            SetStatus(new ConnectionStatus(ConnectionPhase.Connected));
            closeCode = await live.RunAsync(Device!);
            _log.Info($"connection closed ({closeCode?.ToString() ?? "no code"})");
        }
        catch (OperationCanceledException)
        {
            _log.Info(ct.IsCancellationRequested || Kicked() ? "connection closed by the client" : "connecting timed out");
        }
        catch (WebSocketException e)
        {
            closeCode = (int?)ws.CloseStatus;
            _log.Info($"connection failed: {e.WebSocketErrorCode}: {e.Message}");
        }
        catch (Exception e)
        {
            _log.Info($"connection failed: {e.GetType().Name}: {e.Message}");
        }
        finally
        {
            _session = null;
            Device = null;
            lock (_lock)
            {
                _sessionCts = null;
            }

            await CloseQuietlyAsync(ws);
        }

        return new SessionEnd(closeCode, Kicked(), DateTimeOffset.UtcNow - started >= _options.StableAfter);
    }

    private bool Kicked()
    {
        lock (_lock)
        {
            return _kicked;
        }
    }

    private static async Task CloseQuietlyAsync(ClientWebSocket ws)
    {
        try
        {
            if (ws.State is WebSocketState.Open or WebSocketState.CloseReceived)
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                await ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, null, cts.Token);
            }
        }
        catch (Exception e) when (e is WebSocketException or OperationCanceledException or ObjectDisposedException)
        {
            // Already gone.
        }
    }

    private sealed record SessionEnd(int? CloseCode, bool Kicked, bool Stable);

    /// <summary>One connected WebSocket: its loops, its command queue, its running command.</summary>
    private sealed class Session
    {
        private readonly DeviceConnection _owner;
        private readonly ClientWebSocket _ws;
        private readonly CancellationToken _ct;
        private readonly SemaphoreSlim _sendLock = new(1, 1);
        private readonly System.Threading.Channels.Channel<JsonObject> _commands =
            System.Threading.Channels.Channel.CreateUnbounded<JsonObject>();
        private readonly object _lock = new();
        private CancellationTokenSource? _current;
        private bool _stopping;
        private volatile bool _stopPending;
        private long _lastHeardTicks = DateTimeOffset.UtcNow.UtcTicks;

        public Session(DeviceConnection owner, ClientWebSocket ws, CancellationToken ct)
        {
            _owner = owner;
            _ws = ws;
            _ct = ct;
        }

        public async Task SendAsync(string text)
        {
            await _sendLock.WaitAsync(_ct);
            try
            {
                var bytes = System.Text.Encoding.UTF8.GetBytes(text);
                await _ws.SendAsync(bytes, WebSocketMessageType.Text, true, _ct);
            }
            finally
            {
                _sendLock.Release();
            }
        }

        public async Task SendOfferAsync()
        {
            try
            {
                var code = Device is { } device && _owner._codeJobs?.Offered(device) == true;
                var codeStart = Device is { } d && _owner._codeJobs?.OfferedStart(d) == true;
                var files = Device is { } f && _owner._filesOffered(f);
                await SendAsync(Wire.Offer(_owner._control.Effective, _owner._shellSwitchedOn(), code, codeStart, _owner._shellKind(), files, codeInput: _owner._platform == "windows"));
            }
            catch (Exception e) when (e is WebSocketException or OperationCanceledException or ObjectDisposedException)
            {
                // The receive loop notices the lost connection.
            }
        }

        /// <summary>A stop is being answered; its own offer comes last.</summary>
        public bool StopPending => _stopPending;

        /// <summary>The device from <c>welcome</c> (set before the session is used).</summary>
        public DeviceInfo? Device { get; set; }

        /// <summary>The user stopped control: cancel the running command, or say so at once.</summary>
        public async Task StopAsync()
        {
            _stopPending = true;
            lock (_lock)
            {
                if (_current is not null)
                {
                    _stopping = true;
                    _current.Cancel();
                    return; // The worker answers "stopped", then sends device.stopped.
                }
            }

            await SendStoppedAsync();
        }

        /// <summary>The welcome's device, or null when the server closed or sent something else.</summary>
        public async Task<DeviceInfo?> ReceiveWelcomeAsync(CancellationToken ct)
        {
            while (true)
            {
                var text = await ReceiveAsync(ct);
                if (text is null)
                {
                    return null;
                }

                var msg = Wire.Parse(text);
                switch (msg is null ? null : Wire.Type(msg))
                {
                    case "welcome":
                        _owner._cursor = Wire.Str(msg!, "cursor") ?? _owner._cursor;
                        return Wire.Device(msg!);
                    case "notice":
                        Notice(msg!);
                        break;
                    default:
                        return null;
                }
            }
        }

        /// <summary>Runs until the connection ends; returns the server's close code, if any.</summary>
        public async Task<int?> RunAsync(DeviceInfo device)
        {
            using var loopsCts = CancellationTokenSource.CreateLinkedTokenSource(_ct);
            var worker = Task.Run(() => WorkAsync(device, loopsCts.Token));
            var pings = Task.Run(() => PingAsync(loopsCts.Token));
            var offers = Task.Run(() => OfferAsync(loopsCts.Token));
            var code = Task.Run(() => ShareCodeJobsAsync(device, loopsCts.Token));
            try
            {
                while (true)
                {
                    var text = await ReceiveAsync(_ct);
                    if (text is null)
                    {
                        return (int?)_ws.CloseStatus;
                    }

                    Handle(text);
                }
            }
            finally
            {
                _commands.Writer.TryComplete();
                loopsCts.Cancel();
                await Task.WhenAll(Quietly(worker), Quietly(pings), Quietly(offers), Quietly(code));
            }
        }

        private void Handle(string text)
        {
            var msg = Wire.Parse(text);
            if (msg is null)
            {
                return;
            }

            switch (Wire.Type(msg))
            {
                case "device.command" when Wire.Str(msg, "id") is not null:
                    _commands.Writer.TryWrite(msg);
                    break;
                case "notice":
                    Notice(msg);
                    break;
                case "code.ack":
                    _owner._codeJobs?.OnAck(msg);
                    break;
                case "event":
                    _owner._cursor = Wire.Str(msg, "id") ?? _owner._cursor;
                    break;
                default:
                    // pong, and anything this version doesn't know.
                    break;
            }
        }

        private void Notice(JsonObject msg)
        {
            if (Wire.Str(msg, "text") is { Length: > 0 } text)
            {
                _owner._log.Info("notice from Anemo");
                _owner.NoticeReceived?.Invoke(text);
            }
        }

        private async Task WorkAsync(DeviceInfo device, CancellationToken ct)
        {
            await foreach (var command in _commands.Reader.ReadAllAsync(ct))
            {
                var id = Wire.Str(command, "id")!;
                var action = Wire.Str(command, "action") ?? "";
                using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                lock (_lock)
                {
                    _current = cts;
                    _stopping = false;
                }

                _owner.CommandRunning?.Invoke(action);
                CommandOutcome outcome;
                try
                {
                    outcome = await Task.Run(() => _owner._executor.ExecuteAsync(command, device, cts.Token), CancellationToken.None);
                }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                {
                    outcome = CommandOutcome.Fail(Commands.ResultCodes.Stopped, "The user stopped control.");
                }
                catch (OperationCanceledException)
                {
                    _owner.CommandRunning?.Invoke(null);
                    return; // The connection went away; nobody is waiting for the answer here.
                }
                catch (Exception e)
                {
                    _owner._log.Info($"command {action} broke: {e.GetType().Name}");
                    outcome = CommandOutcome.Fail(Commands.ResultCodes.Failed, "Anemo Desktop ran into an error doing that.");
                }

                bool stopped;
                lock (_lock)
                {
                    stopped = _stopping;
                    _current = null;
                    _stopping = false;
                }

                if (stopped)
                {
                    outcome = CommandOutcome.Fail(Commands.ResultCodes.Stopped, "The user stopped control.");
                }

                _owner.CommandRunning?.Invoke(null);
                await SendAsync(Wire.Result(id, outcome));
                if (stopped)
                {
                    await SendStoppedAsync();
                }
            }
        }

        /// <summary>
        /// Claude Code jobs (device-contracts.md §7) beside the commands: their frames go through
        /// the same send lock, one at a time. A failure there never ends the connection.
        /// </summary>
        private async Task ShareCodeJobsAsync(DeviceInfo device, CancellationToken ct)
        {
            if (_owner._codeJobs is not { } host)
            {
                return;
            }

            try
            {
                await host.RunAsync(new CodeJobsLink(this), device, ct);
            }
            catch (Exception e) when (e is OperationCanceledException or WebSocketException or ObjectDisposedException)
            {
                // The connection ended.
            }
            catch (Exception e)
            {
                _owner._log.Info($"code jobs stopped: {e.GetType().Name}");
            }
        }

        private async Task SendStoppedAsync()
        {
            try
            {
                await SendAsync(Wire.Stopped());
            }
            catch (Exception e) when (e is WebSocketException or OperationCanceledException or ObjectDisposedException)
            {
                _stopPending = false;
                return;
            }

            await SendOfferAsync();
            _stopPending = false;
        }

        private async Task PingAsync(CancellationToken ct)
        {
            while (!ct.IsCancellationRequested)
            {
                await Task.Delay(_owner._options.PingInterval, ct);
                var lastHeard = new DateTimeOffset(Interlocked.Read(ref _lastHeardTicks), TimeSpan.Zero);
                if (DateTimeOffset.UtcNow - lastHeard > _owner._options.SilenceTimeout)
                {
                    _owner._log.Info("nothing heard from Anemo; reconnecting");
                    _ws.Abort();
                    return;
                }

                await SendAsync(Wire.Ping());
            }
        }

        private async Task OfferAsync(CancellationToken ct)
        {
            while (!ct.IsCancellationRequested)
            {
                await SendOfferAsync();
                await Task.Delay(_owner._options.OfferInterval, ct);
            }
        }

        /// <summary>The next text message, or null when the server closed.</summary>
        private async Task<string?> ReceiveAsync(CancellationToken ct)
        {
            var buffer = new byte[16 * 1024];
            using var message = new MemoryStream();
            while (true)
            {
                var result = await _ws.ReceiveAsync(buffer, ct);
                Interlocked.Exchange(ref _lastHeardTicks, DateTimeOffset.UtcNow.UtcTicks);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    return null;
                }

                message.Write(buffer, 0, result.Count);
                if (message.Length > _owner._options.MaxMessageBytes)
                {
                    throw new WebSocketException(WebSocketError.Faulted, "A message from Anemo was too large.");
                }

                if (!result.EndOfMessage)
                {
                    continue;
                }

                if (result.MessageType != WebSocketMessageType.Text)
                {
                    message.SetLength(0);
                    continue;
                }

                return System.Text.Encoding.UTF8.GetString(message.GetBuffer(), 0, (int)message.Length);
            }
        }

        private sealed class CodeJobsLink : ICodeJobsLink
        {
            private readonly Session _session;

            public CodeJobsLink(Session session) => _session = session;

            public Task SendAsync(string text, CancellationToken ct)
            {
                ct.ThrowIfCancellationRequested();
                return _session.SendAsync(text);
            }

            public void Drop() => _session._ws.Abort();
        }

        private static async Task Quietly(Task task)
        {
            try
            {
                await task;
            }
            catch (Exception e) when (e is OperationCanceledException or WebSocketException or ObjectDisposedException
                or System.Threading.Channels.ChannelClosedException)
            {
                // The connection ended.
            }
        }
    }
}
