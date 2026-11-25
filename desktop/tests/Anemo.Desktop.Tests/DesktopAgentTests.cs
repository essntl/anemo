using System.Text.Json.Nodes;
using Anemo.Desktop.Core;
using Anemo.Desktop.Core.Connection;
using Anemo.Desktop.Core.Platform;
using Anemo.Desktop.Core.Storage;
using Anemo.Desktop.Tests.Fakes;

namespace Anemo.Desktop.Tests;

/// <summary>The whole client without its window, against the fake server: settings, sharing, trust.</summary>
public sealed class DesktopAgentTests : IAsyncLifetime
{
    private readonly string _folder = Path.Combine(Path.GetTempPath(), "anemo-desktop-tests", Guid.NewGuid().ToString("N"));
    private readonly FakePlatform _platform = new();
    private readonly CancellationTokenSource _stop = new();
    private readonly HttpClient _http = new();
    private FakeAnemoServer _server = null!;
    private SettingsStore _store = null!;
    private Task _running = Task.CompletedTask;

    public async Task InitializeAsync()
    {
        _server = await FakeAnemoServer.StartAsync();
        _store = new SettingsStore(Path.Combine(_folder, "settings.json"), new FakeProtector());
        _platform.Desktop.Tree = _ => new UiTree(
            [new UiNode(0, "text", "Quarterly report", null, true, false, false, null)], false);
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
        _http.Dispose();
        if (Directory.Exists(_folder))
        {
            Directory.Delete(_folder, true);
        }
    }

    [Fact]
    public async Task Saving_an_address_and_token_connects()
    {
        var agent = Create();
        _running = agent.RunAsync(_stop.Token);
        Assert.False(agent.HasToken);

        agent.Save(agent.Settings with { Address = _server.BaseUri.ToString() }, FakeAnemoServer.Token);

        var client = await _server.NextClientAsync();
        Assert.Equal(FakeAnemoServer.Token, (string?)client.Hello!["token"]);
        Assert.DoesNotContain(FakeAnemoServer.Token, File.ReadAllText(_store.Path));
    }

    [Fact]
    public async Task Switching_PowerShell_on_sends_a_new_offer()
    {
        var agent = Configured();
        _running = agent.RunAsync(_stop.Token);
        var client = await _server.NextClientAsync();
        Assert.False((bool)(await client.NextAsync("device.offer"))["shell"]!);

        agent.Save(agent.Settings with { PowerShellEnabled = true }, newToken: null);

        Assert.True((bool)(await client.NextAsync("device.offer"))["shell"]!);
        Assert.Equal(1, _server.Connections);
    }

    [Fact]
    public async Task Files_are_offered_on_a_trusted_device_with_the_switch_on()
    {
        _server.Trust = "trusted";
        var agent = Configured();
        _running = agent.RunAsync(_stop.Token);
        var client = await _server.NextClientAsync();
        Assert.False((bool)(await client.NextAsync("device.offer"))["files"]!);

        agent.Save(agent.Settings with { ShareFiles = true }, newToken: null);
        Assert.True((bool)(await client.NextAsync("device.offer"))["files"]!);

        _server.Trust = "watched";
        agent.Connection.Reconnect();
        client = await _server.NextClientAsync();
        Assert.False((bool)(await client.NextAsync("device.offer"))["files"]!);
    }

    [Fact]
    public async Task Shell_runs_only_on_a_trusted_device_with_PowerShell_on()
    {
        _server.Trust = "watched";
        var agent = Configured(powerShell: true);
        _running = agent.RunAsync(_stop.Token);
        var client = await _server.NextClientAsync();

        await client.CommandAsync("s1", "shell", new JsonObject { ["command"] = "hostname", ["timeout_s"] = 5 });
        var refused = await client.NextAsync("device.result");
        Assert.Equal("refused", (string?)refused["code"]);
        Assert.Empty(_platform.Shell.Started);

        _server.Trust = "trusted";
        agent.Connection.Reconnect();
        client = await _server.NextClientAsync();
        await client.CommandAsync("s2", "shell", new JsonObject { ["command"] = "hostname", ["timeout_s"] = 5 });
        var ran = await client.NextAsync("device.result");
        Assert.True((bool)ran["ok"]!);
        Assert.Equal("hello\n", (string?)ran["state"]!["stdout"]);
    }

    [Fact]
    public void Pausing_is_saved_so_it_survives_a_restart()
    {
        var agent = Configured();

        agent.Control.Stop();

        var again = new DesktopAgent(Parts());
        Assert.False(again.Control.Effective);
        Assert.NotNull(again.Settings.PausedUntil);
    }

    [Fact]
    public async Task Stop_cancels_the_command_even_when_settings_json_cannot_be_written()
    {
        var agent = Configured();
        _platform.Desktop.Focused = new FakeElement();
        var typing = new TaskCompletionSource();
        _platform.Input.OnTypedChar = _ =>
        {
            typing.TrySetResult();
            Thread.Sleep(20);
        };
        _running = agent.RunAsync(_stop.Token);
        var client = await _server.NextClientAsync();
        await client.NextAsync("device.offer");

        // From now on the settings file can't be written.
        File.Delete(_store.Path);
        Directory.CreateDirectory(_store.Path);
        File.WriteAllText(Path.Combine(_store.Path, "x"), "");

        await client.CommandAsync("t1", "type", new JsonObject { ["text"] = new string('a', 2000) });
        await typing.Task.WaitAsync(TimeSpan.FromSeconds(5));
        agent.Control.Stop();

        var result = await client.NextAsync("device.result");
        Assert.Equal("stopped", (string?)result["code"]);
        await client.NextAsync("device.stopped");
        Assert.False(agent.Control.Effective);
    }

    [Fact]
    public void A_damaged_settings_file_starts_with_control_off()
    {
        Directory.CreateDirectory(_folder);
        File.WriteAllText(_store.Path, "{ broken");

        var agent = Create();

        Assert.False(agent.Control.AllowControl);
        Assert.NotNull(agent.StartupProblem);
    }

    [Fact]
    public async Task Share_this_screen_puts_the_screenshot_and_window_text_with_the_bearer_token()
    {
        var agent = Configured();

        var result = await agent.ShareScreenAsync(CancellationToken.None);

        Assert.True(result.Ok, result.Message);
        var body = _server.SharedScreen!;
        Assert.Equal(Convert.ToBase64String(FakeDesktop.Png), (string?)body["screenshot"]);
        Assert.Equal("Book1 - Excel", (string?)body["window"]!["title"]);
        Assert.Equal("EXCEL.EXE", (string?)body["window"]!["app"]);
        Assert.Contains("Quarterly report", (string?)body["text"]);

        var request = _server.Requests.Single(r => r.Path == "/api/devices/shared-screen");
        Assert.Equal("PUT", request.Method);
        Assert.Equal($"Bearer {FakeAnemoServer.Token}", request.Authorization);
        Assert.Equal("", request.Query);
    }

    [Fact]
    public async Task Share_with_a_revoked_token_says_so()
    {
        var agent = Configured(token: "anemo_revoked");

        var result = await agent.ShareScreenAsync(CancellationToken.None);

        Assert.False(result.Ok);
        Assert.Contains("token", result.Message);
        Assert.Null(_server.SharedScreen);
    }

    [Fact]
    public async Task Share_on_the_secure_desktop_is_not_tried()
    {
        var agent = Configured();
        _platform.Desktop.Secure = true;

        var result = await agent.ShareScreenAsync(CancellationToken.None);

        Assert.False(result.Ok);
        Assert.Empty(_server.Requests);
    }

    [Fact]
    public async Task Share_without_settings_asks_for_them()
    {
        var result = await Create().ShareScreenAsync(CancellationToken.None);

        Assert.False(result.Ok);
        Assert.Contains("Settings", result.Message);
    }

    [Fact]
    public async Task A_restart_for_an_update_waits_for_a_command_and_the_minute_after_it()
    {
        var time = new ManualTime { Now = DateTimeOffset.UtcNow };
        var settings = _store.WithToken(new DesktopSettings { Address = _server.BaseUri.ToString() }, FakeAnemoServer.Token);
        _store.Save(settings);
        var agent = new DesktopAgent(Parts(time));
        Assert.Null(agent.BusyReason());

        _running = agent.RunAsync(_stop.Token);
        var client = await _server.NextClientAsync();
        await client.CommandAsync("l1", "look", new JsonObject { ["what"] = "window" });
        await client.NextAsync("device.result");

        Assert.Equal("the agent used this computer a moment ago", agent.BusyReason());
        time.Now += DesktopAgent.QuietBeforeRestart;
        Assert.Null(agent.BusyReason());
    }

    [Fact]
    public void A_client_without_an_update_host_does_not_update()
    {
        var agent = Create();

        Assert.Equal(Core.Updates.UpdatePhase.Unavailable, agent.Updates.State.Phase);
        Assert.Null(agent.Updates.Ready);
        Assert.True(agent.Settings.AutoUpdate); // on by default
    }

    private DesktopAgent Create() => new(Parts());

    private DesktopAgent Configured(string token = FakeAnemoServer.Token, bool powerShell = false)
    {
        var settings = _store.WithToken(new DesktopSettings { Address = _server.BaseUri.ToString(), PowerShellEnabled = powerShell }, token);
        _store.Save(settings);
        return Create();
    }

    private DesktopAgentParts Parts(TimeProvider? time = null) => new(
        _store,
        _platform.Services,
        new CommandLog(Path.Combine(_folder, "log"), TimeProvider.System),
        new ListLog(),
        time ?? TimeProvider.System,
        _http,
        "1.0.0",
        @"C:\Users\me\AnemoWork",
        new DeviceConnectionOptions
        {
            Backoff = () => new Backoff(TimeSpan.FromMilliseconds(50), TimeSpan.FromMilliseconds(200)),
        },
        new Core.Commands.CommandOptions { SettleDelay = TimeSpan.Zero, OpenDelay = TimeSpan.Zero });
}
