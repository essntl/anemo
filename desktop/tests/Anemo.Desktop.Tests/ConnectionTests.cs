using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using Anemo.Desktop.Core.Commands;
using Anemo.Desktop.Core.Connection;
using Anemo.Desktop.Core.Control;
using Anemo.Desktop.Core.Protocol;
using Anemo.Desktop.Tests.Fakes;

namespace Anemo.Desktop.Tests;

/// <summary>The WebSocket of device-contracts.md §2 against the fake server, message by message.</summary>
public sealed class ConnectionTests : IAsyncLifetime
{
    private static readonly TimeSpan Short = TimeSpan.FromSeconds(1);

    private FakeAnemoServer _server = null!;
    private readonly CancellationTokenSource _stop = new();
    private readonly ListLog _log = new();
    private readonly ManualTime _time = new();
    private ControlState _control = null!;
    private Task _running = Task.CompletedTask;
    private string _token = FakeAnemoServer.Token;

    public async Task InitializeAsync()
    {
        _server = await FakeAnemoServer.StartAsync();
        _control = new ControlState(_time, allow: true, pausedUntil: null);
    }

    public async Task DisposeAsync()
    {
        _stop.Cancel();
        try
        {
            await _running.WaitAsync(TimeSpan.FromSeconds(5));
        }
        catch (OperationCanceledException)
        {
        }

        await _server.DisposeAsync();
    }

    [Fact]
    public async Task Hello_carries_the_token_kind_and_version_and_nothing_secret_is_in_the_url()
    {
        Start(new ScriptedExecutor());
        var client = await _server.NextClientAsync();

        Assert.Equal("hello", (string?)client.Hello!["type"]);
        Assert.Equal(FakeAnemoServer.Token, (string?)client.Hello["token"]);
        Assert.Equal("computer", (string?)client.Hello["kind"]);
        Assert.Equal("1.0.0", (string?)client.Hello["version"]);
        Assert.Null(client.Hello["last_id"]);

        var request = Assert.Single(_server.Requests, r => r.Path == "/api/devices/ws");
        Assert.Equal("", request.Query);
        Assert.Null(request.Origin);
        Assert.Null(request.Authorization);
        Assert.DoesNotContain(FakeAnemoServer.Token, request.Path + request.Query);
    }

    [Fact]
    public async Task Offer_is_sent_after_welcome_and_renewed()
    {
        var connection = Start(new ScriptedExecutor(), offerEvery: TimeSpan.FromMilliseconds(200));
        var client = await _server.NextClientAsync();

        var first = await client.NextAsync("device.offer");
        Assert.True((bool)first["control"]!);
        Assert.False((bool)first["shell"]!);
        await client.NextAsync("device.offer");

        Assert.True(connection.Status.IsConnected);
        Assert.Equal("Desk PC", connection.Device!.Name);
        Assert.Equal("watched", connection.Device.Trust);
    }

    [Fact]
    public async Task Offer_says_shell_when_PowerShell_is_switched_on()
    {
        Start(new ScriptedExecutor(), shellOn: true);
        var client = await _server.NextClientAsync();

        var offer = await client.NextAsync("device.offer");
        Assert.True((bool)offer["shell"]!);
    }

    [Fact]
    public async Task Pings_go_out_and_pongs_keep_the_connection()
    {
        var connection = Start(new ScriptedExecutor(), pingEvery: TimeSpan.FromMilliseconds(100), silence: TimeSpan.FromSeconds(2));
        var client = await _server.NextClientAsync();

        var ping = await client.NextAsync("ping");
        Assert.Equal("ping", (string?)ping["type"]);
        await Task.Delay(1000);
        Assert.True(connection.Status.IsConnected);
        Assert.Equal(1, _server.Connections);
    }

    [Fact]
    public async Task Silence_from_the_server_makes_the_client_reconnect()
    {
        _server.AnswerPings = false;
        Start(new ScriptedExecutor(), pingEvery: TimeSpan.FromMilliseconds(100), silence: TimeSpan.FromMilliseconds(300));
        await _server.NextClientAsync();

        await _server.NextClientAsync(TimeSpan.FromSeconds(5));
    }

    [Fact]
    public async Task A_command_is_answered_with_its_result()
    {
        var executor = new ScriptedExecutor
        {
            Answer = cmd => CommandOutcome.Success(new JsonObject { ["seen"] = (string?)cmd["action"] }),
        };
        Start(executor);
        var client = await _server.NextClientAsync();

        await client.CommandAsync("cmd-1", "look", new JsonObject { ["what"] = "screen" });
        var result = await client.NextAsync("device.result");

        Assert.Equal("cmd-1", (string?)result["id"]);
        Assert.True((bool)result["ok"]!);
        Assert.Equal("look", (string?)result["state"]!["seen"]);
        Assert.Equal("watched", executor.Devices.Single().Trust);
    }

    [Fact]
    public async Task A_failed_command_carries_error_and_code()
    {
        var executor = new ScriptedExecutor { Answer = _ => CommandOutcome.Fail("refused", "Control is off.") };
        Start(executor);
        var client = await _server.NextClientAsync();

        await client.CommandAsync("cmd-2", "click", new JsonObject { ["ref"] = "c1" });
        var result = await client.NextAsync("device.result");

        Assert.False((bool)result["ok"]!);
        Assert.Equal("Control is off.", (string?)result["error"]);
        Assert.Equal("refused", (string?)result["code"]);
        Assert.Null(result["state"]);
    }

    [Fact]
    public async Task Commands_run_one_at_a_time_in_order()
    {
        var executor = new ScriptedExecutor { Delay = TimeSpan.FromMilliseconds(80) };
        Start(executor);
        var client = await _server.NextClientAsync();

        for (var i = 1; i <= 4; i++)
        {
            await client.CommandAsync($"cmd-{i}", "look");
        }

        var ids = new List<string>();
        for (var i = 1; i <= 4; i++)
        {
            ids.Add((string)(await client.NextAsync("device.result"))["id"]!);
        }

        Assert.Equal(["cmd-1", "cmd-2", "cmd-3", "cmd-4"], ids);
        Assert.Equal(1, executor.MaxConcurrent);
        Assert.Equal(["cmd-1", "cmd-2", "cmd-3", "cmd-4"], executor.Seen);
    }

    [Fact]
    public async Task An_unknown_action_fails_loudly_with_the_real_handlers()
    {
        var platform = new FakePlatform();
        var processor = new CommandProcessor(platform.Services, _control, () => new Core.Storage.DesktopSettings());
        Start(processor);
        var client = await _server.NextClientAsync();

        await client.CommandAsync("cmd-x", "dance");
        var result = await client.NextAsync("device.result");

        Assert.False((bool)result["ok"]!);
        Assert.Equal("failed", (string?)result["code"]);
        Assert.Equal("Unknown action “dance”", (string?)result["error"]);
    }

    [Fact]
    public async Task The_stop_hotkey_cancels_the_running_command_and_tells_Anemo()
    {
        var executor = new ScriptedExecutor { WaitForCancel = true };
        Start(executor);
        var client = await _server.NextClientAsync();
        await client.NextAsync("device.offer");

        await client.CommandAsync("cmd-long", "type", new JsonObject { ["text"] = "a long text" });
        await executor.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        _control.Stop();

        var result = await client.NextAsync("device.result");
        Assert.Equal("cmd-long", (string?)result["id"]);
        Assert.False((bool)result["ok"]!);
        Assert.Equal(ResultCodes.Stopped, (string?)result["code"]);
        await client.NextAsync("device.stopped");
        var offer = await client.NextAsync("device.offer");
        Assert.False((bool)offer["control"]!);
    }

    [Fact]
    public async Task Stop_without_a_command_sends_stopped_and_an_offer_without_control()
    {
        Start(new ScriptedExecutor());
        var client = await _server.NextClientAsync();
        await client.NextAsync("device.offer");

        _control.Stop();

        await client.NextAsync("device.stopped");
        var offer = await client.NextAsync("device.offer");
        Assert.False((bool)offer["control"]!);
        Assert.NotNull(_control.PausedUntil);
    }

    [Fact]
    public async Task Switching_control_off_sends_an_offer_at_once()
    {
        Start(new ScriptedExecutor(), offerEvery: TimeSpan.FromMinutes(5));
        var client = await _server.NextClientAsync();
        Assert.True((bool)(await client.NextAsync("device.offer"))["control"]!);

        _control.SetAllow(false);

        Assert.False((bool)(await client.NextAsync("device.offer"))["control"]!);
    }

    [Fact]
    public async Task A_notice_is_passed_on()
    {
        _server.MinVersion = new Version(2, 0, 0);
        var notices = new ConcurrentQueue<string>();
        var connection = Create(new ScriptedExecutor());
        connection.NoticeReceived += notices.Enqueue;
        _running = connection.RunAsync(_stop.Token);

        await _server.NextClientAsync();
        await WaitUntil(() => !notices.IsEmpty);
        Assert.Equal("Please update Anemo Desktop.", notices.Single());
    }

    [Theory]
    [InlineData(4401)]
    [InlineData(4409)]
    public async Task A_final_close_code_stops_reconnecting_until_new_settings(int code)
    {
        var connection = Start(new ScriptedExecutor());
        var client = await _server.NextClientAsync();
        await client.NextAsync("device.offer");

        await client.CloseAsync(code);

        await WaitUntil(() => connection.Status.Phase == ConnectionPhase.Refused);
        Assert.Equal(CloseCodes.FinalMessage(code), connection.Status.Message);
        Assert.True(await _server.NoClientWithinAsync(TimeSpan.FromMilliseconds(1500)));

        connection.Reconnect();
        await _server.NextClientAsync();
    }

    [Fact]
    public async Task A_wrong_token_is_closed_with_4401_and_shown()
    {
        _token = "anemo_wrong";
        var connection = Start(new ScriptedExecutor());

        await _server.NextClientAsync();
        await WaitUntil(() => connection.Status.Phase == ConnectionPhase.Refused);
        Assert.Contains("token", connection.Status.Message);
        Assert.True(await _server.NoClientWithinAsync(Short));
    }

    [Fact]
    public async Task A_phone_token_is_closed_with_4400_and_shown()
    {
        _server.Kind = "phone";
        var connection = Start(new ScriptedExecutor());

        await _server.NextClientAsync();
        await WaitUntil(() => connection.Status.Phase == ConnectionPhase.Refused);
        Assert.Equal(CloseCodes.FinalMessage(4400), connection.Status.Message);
    }

    [Fact]
    public async Task A_4403_close_is_shown_and_not_retried()
    {
        var connection = Start(new ScriptedExecutor());
        var client = await _server.NextClientAsync();
        await client.NextAsync("device.offer");

        await client.CloseAsync(4403);

        await WaitUntil(() => connection.Status.Phase == ConnectionPhase.Refused);
        Assert.Equal(CloseCodes.FinalMessage(4403), connection.Status.Message);
        Assert.True(await _server.NoClientWithinAsync(Short));
    }

    [Fact]
    public async Task After_a_drop_it_reconnects_and_resumes_from_the_cursor()
    {
        Start(new ScriptedExecutor());
        var first = await _server.NextClientAsync();
        await first.NextAsync("device.offer");
        await first.SendAsync(new JsonObject { ["type"] = "event", ["id"] = "evt-7", ["event"] = "x", ["data"] = new JsonObject() });
        await first.SendAsync(new JsonObject { ["type"] = "pong" });
        await Task.Delay(200);

        await first.CloseAsync(1001);

        var second = await _server.NextClientAsync();
        Assert.Equal("evt-7", (string?)second.Hello!["last_id"]);
        await second.NextAsync("device.offer");
    }

    [Fact]
    public async Task After_a_server_restart_the_cursor_of_welcome_is_used()
    {
        Start(new ScriptedExecutor());
        var first = await _server.NextClientAsync();
        await first.NextAsync("device.offer");

        first.Abort();

        var second = await _server.NextClientAsync();
        Assert.Equal("cursor-1", (string?)second.Hello!["last_id"]);
    }

    [Fact]
    public async Task No_welcome_in_time_means_trying_again()
    {
        _server.Mute = true;
        Start(new ScriptedExecutor(), welcomeTimeout: TimeSpan.FromMilliseconds(300));

        await _server.NextClientAsync();
        await _server.NextClientAsync(TimeSpan.FromSeconds(5));
    }

    [Fact]
    public async Task Without_settings_it_waits_and_connects_once_they_come()
    {
        ConnectionSettings? settings = null;
        var connection = new DeviceConnection(() => settings, _control, () => false, new ScriptedExecutor(), _log, "1.0.0", FastOptions());
        _running = connection.RunAsync(_stop.Token);

        await WaitUntil(() => connection.Status.Phase == ConnectionPhase.NotConfigured);
        Assert.True(await _server.NoClientWithinAsync(TimeSpan.FromMilliseconds(300)));

        settings = new ConnectionSettings(AnemoAddress.Parse(_server.BaseUri.ToString())!, FakeAnemoServer.Token);
        connection.Reconnect();
        await _server.NextClientAsync();
    }

    [Fact]
    public async Task The_token_never_reaches_the_diagnostic_log()
    {
        _token = FakeAnemoServer.Token + "x";
        var connection = Start(new ScriptedExecutor());
        await _server.NextClientAsync();
        await WaitUntil(() => connection.Status.Phase == ConnectionPhase.Refused);

        Assert.NotEmpty(_log.Lines);
        Assert.DoesNotContain(_log.Lines, l => l.Contains("anemo_", StringComparison.Ordinal));
    }

    private DeviceConnection Start(
        ICommandExecutor executor,
        bool shellOn = false,
        TimeSpan? offerEvery = null,
        TimeSpan? pingEvery = null,
        TimeSpan? silence = null,
        TimeSpan? welcomeTimeout = null)
    {
        var connection = Create(executor, shellOn, offerEvery, pingEvery, silence, welcomeTimeout);
        _running = connection.RunAsync(_stop.Token);
        return connection;
    }

    private DeviceConnection Create(
        ICommandExecutor executor,
        bool shellOn = false,
        TimeSpan? offerEvery = null,
        TimeSpan? pingEvery = null,
        TimeSpan? silence = null,
        TimeSpan? welcomeTimeout = null)
    {
        var settings = new ConnectionSettings(AnemoAddress.Parse(_server.BaseUri.ToString())!, _token);
        return new DeviceConnection(
            () => settings,
            _control,
            () => shellOn,
            executor,
            _log,
            "1.0.0",
            FastOptions(offerEvery, pingEvery, silence, welcomeTimeout));
    }

    private static DeviceConnectionOptions FastOptions(
        TimeSpan? offerEvery = null, TimeSpan? pingEvery = null, TimeSpan? silence = null, TimeSpan? welcomeTimeout = null) => new()
    {
        OfferInterval = offerEvery ?? TimeSpan.FromSeconds(30),
        PingInterval = pingEvery ?? TimeSpan.FromSeconds(20),
        SilenceTimeout = silence ?? TimeSpan.FromSeconds(65),
        WelcomeTimeout = welcomeTimeout ?? TimeSpan.FromSeconds(5),
        Backoff = () => new Backoff(TimeSpan.FromMilliseconds(50), TimeSpan.FromMilliseconds(200)),
    };

    private static async Task WaitUntil(Func<bool> condition)
    {
        var until = DateTime.UtcNow.AddSeconds(10);
        while (!condition())
        {
            if (DateTime.UtcNow > until)
            {
                throw new TimeoutException("The condition never became true.");
            }

            await Task.Delay(20);
        }
    }
}

/// <summary>An executor whose answers the test decides; it records order and concurrency.</summary>
public sealed class ScriptedExecutor : ICommandExecutor
{
    private int _running;

    public Func<JsonObject, CommandOutcome> Answer { get; init; } = _ => CommandOutcome.Success(new JsonObject());

    public TimeSpan Delay { get; init; }

    public bool WaitForCancel { get; init; }

    public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public ConcurrentQueue<string> Seen { get; } = new();

    public ConcurrentQueue<DeviceInfo> Devices { get; } = new();

    public int MaxConcurrent { get; private set; }

    public async Task<CommandOutcome> ExecuteAsync(JsonObject command, DeviceInfo device, CancellationToken ct)
    {
        var now = Interlocked.Increment(ref _running);
        MaxConcurrent = Math.Max(MaxConcurrent, now);
        Seen.Enqueue((string)command["id"]!);
        Devices.Enqueue(device);
        Started.TrySetResult();
        try
        {
            if (WaitForCancel)
            {
                await Task.Delay(Timeout.Infinite, ct);
            }

            await Task.Delay(Delay, ct);
            return Answer(command);
        }
        finally
        {
            Interlocked.Decrement(ref _running);
        }
    }
}
