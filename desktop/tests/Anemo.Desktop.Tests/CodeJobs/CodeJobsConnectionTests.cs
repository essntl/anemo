using System.Text.Json.Nodes;
using Anemo.Desktop.Core;
using Anemo.Desktop.Core.CodeJobs;
using Anemo.Desktop.Core.Connection;
using Anemo.Desktop.Core.Platform;
using Anemo.Desktop.Core.Storage;
using Anemo.Desktop.Tests.Fakes;

namespace Anemo.Desktop.Tests.CodeJobs;

/// <summary>Claude Code jobs over the real connection, against the fake Anemo server (§7).</summary>
public sealed class CodeJobsConnectionTests : IAsyncLifetime
{
    private readonly JobsFolder _jobs = new();
    private readonly FakePlatform _platform = new();
    private readonly FakeProcesses _processes = new();
    private readonly ListLog _log = new();
    private readonly CancellationTokenSource _stop = new();
    private readonly HttpClient _http = new();
    private readonly FakeCodeServer _code = new();
    private readonly FakeCodeHost _host = FakeCodeHost.WithEverything();
    private FakeAnemoServer _server = null!;
    private SettingsStore _store = null!;
    private Task _running = Task.CompletedTask;

    public async Task InitializeAsync()
    {
        _server = await FakeAnemoServer.StartAsync();
        _server.Trust = "trusted";
        _server.Code = _code;
        _store = new SettingsStore(Path.Combine(_jobs.Root, "settings.json"), new FakeProtector());
        _platform.Desktop.Tree = _ => new UiTree([new UiNode(0, "text", "Quarterly report", null, true, false, false, null)], false);
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
        _jobs.Dispose();
    }

    [Fact]
    public async Task A_trusted_device_with_sharing_on_offers_code_and_streams_its_jobs()
    {
        var job = RunningJob();
        job.WriteTurn(3);
        Start(share: true);
        var client = await _server.NextClientAsync();

        Assert.Equal("1.1.0", (string?)client.Hello!["version"]);
        Assert.True((bool)(await client.NextAsync("device.offer"))["code"]!);
        var announce = await client.NextAsync("code.job");
        Assert.Equal(job.Id, (string?)announce["job"]!["id"]);
        var frame = await client.NextAsync("code.events");
        Assert.Equal(1, (long)frame["events"]![0]!["seq"]!);
        await WaitForAsync(() => Seq(job.Id) == 10);

        // Commands keep working beside the jobs.
        job.Write(Enumerable.Range(0, 300).Select(i => CodeEvents.Text($"line {i}")).ToArray());
        await client.CommandAsync("cmd-1", "look", new JsonObject { ["what"] = "windows" });
        Assert.True((bool)(await client.NextAsync("device.result"))["ok"]!);
        await WaitForAsync(() => Seq(job.Id) == 310);
        Assert.Empty(client.Dropped);
    }

    [Fact]
    public async Task After_a_reconnect_the_job_is_announced_again_and_goes_on_from_the_server_s_ack()
    {
        var job = RunningJob();
        job.WriteTurn(2);
        Start(share: true);
        var first = await _server.NextClientAsync();
        await WaitForAsync(() => Seq(job.Id) == 7);

        first.Abort();
        job.Write(CodeEvents.Text("written while offline"));
        job.Finish();
        _processes.Running.Clear();
        var second = await _server.NextClientAsync();

        // code.job first; the events from the server's ack (7) on; the terminal state after them.
        var announce = await second.NextAsync("code.job");
        Assert.Equal("running", (string?)announce["job"]!["state"]);
        var seqs = new List<long>();
        while (true)
        {
            var msg = await second.NextAsync();
            if ((string?)msg["type"] == "code.events")
            {
                seqs.AddRange(msg["events"]!.AsArray().Select(i => (long)i!["seq"]!));
            }
            else if ((string?)msg["type"] == "code.job" && (string?)msg["job"]!["state"] == "done")
            {
                break;
            }
        }

        Assert.Equal([8L, 9L], seqs);
        await WaitForAsync(() => Agent!.CodeJobs.Store.Get(job.Id)?.Settled == true);
    }

    [Fact]
    public async Task A_job_started_by_a_command_is_answered_then_shared()
    {
        var projects = Path.Combine(_jobs.Root, "projects");
        Directory.CreateDirectory(Path.Combine(projects, "anemo"));
        _processes.Running[9000] = DateTimeOffset.UtcNow; // the started cmd.exe
        Start(share: true, start: true, projects);
        var client = await _server.NextClientAsync();

        var offer = await client.NextAsync("device.offer");
        Assert.True((bool)offer["code"]!);
        Assert.True((bool)offer["code_start"]!);

        await client.CommandAsync("cmd-start", "code_start", new JsonObject
        {
            ["project"] = "anemo",
            ["prompt"] = "Fix the flaky test.",
            ["new"] = false,
            ["resume_session"] = null,
            ["model"] = null,
            ["max_turns"] = null,
        });
        // The result and the job's first code.job, in whichever order they come.
        JsonObject? result = null, announce = null;
        while (result is null || announce is null)
        {
            var msg = await client.NextAsync();
            switch ((string?)msg["type"])
            {
                case "device.result":
                    result = msg;
                    break;
                case "code.job":
                    announce ??= msg;
                    break;
            }
        }

        Assert.True((bool)result["ok"]!, result.ToJsonString());
        var jobId = (string)result["state"]!["job_id"]!;
        Assert.Equal(Path.Combine(projects, "anemo"), (string?)result["state"]!["dir"]);
        Assert.Equal("anemo", (string?)result["state"]!["project"]);
        Assert.Equal(jobId, (string?)announce["job"]!["id"]);
        Assert.Equal("running", (string?)announce["job"]!["state"]);
        Assert.Equal("Fix the flaky test.", (string?)announce["job"]!["prompt"]);
        Assert.Equal(9000, (int?)announce["job"]!["pid"]);
    }

    [Fact]
    public async Task With_starting_off_the_offer_has_no_code_start_and_code_start_is_refused()
    {
        Start(share: true);
        var client = await _server.NextClientAsync();

        Assert.False((bool)(await client.NextAsync("device.offer"))["code_start"]!);
        await client.CommandAsync("cmd-start", "code_start", new JsonObject { ["project"] = "anemo", ["prompt"] = "x" });
        var result = await client.NextAsync("device.result");

        Assert.False((bool)result["ok"]!);
        Assert.Equal("refused", (string?)result["code"]);
        Assert.Empty(_host.Started);

        // Switching it on in Settings offers it at once, without a reconnect.
        Agent!.Save(Agent.Settings with { StartCodeJobs = true }, newToken: null);
        Assert.True((bool)(await client.NextAsync("device.offer"))["code_start"]!);
        Assert.Equal(1, _server.Connections);
    }

    [Fact]
    public async Task A_watched_device_offers_no_code_and_sends_no_jobs()
    {
        _server.Trust = "watched";
        RunningJob().WriteTurn(1);
        Start(share: true);
        var client = await _server.NextClientAsync();

        Assert.False((bool)(await client.NextAsync("device.offer"))["code"]!);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => client.NextAsync("code.job", TimeSpan.FromMilliseconds(600)));
    }

    [Fact]
    public async Task Sharing_off_offers_no_code_and_switching_it_on_starts_without_a_reconnect()
    {
        var job = RunningJob();
        job.WriteTurn(1);
        Start(share: false);
        var client = await _server.NextClientAsync();
        Assert.False((bool)(await client.NextAsync("device.offer"))["code"]!);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => client.NextAsync("code.job", TimeSpan.FromMilliseconds(400)));

        Agent!.Save(Agent.Settings with { ShareCodeJobs = true }, newToken: null);

        Assert.True((bool)(await client.NextAsync("device.offer"))["code"]!);
        await client.NextAsync("code.job");
        await WaitForAsync(() => Seq(job.Id) == 4);

        Agent.Save(Agent.Settings with { ShareCodeJobs = false }, newToken: null);
        Assert.False((bool)(await client.NextAsync("device.offer"))["code"]!);
        Assert.Equal(1, _server.Connections);
    }

    private DesktopAgent? Agent { get; set; }

    private long Seq(string jobId) => _code.Jobs.TryGetValue(jobId, out var job) ? job.LastSeq : -1;

    private FakeJob RunningJob()
    {
        var job = _jobs.Add(DateTimeOffset.UtcNow.AddMinutes(-1));
        _processes.Running[4242] = job.Started;
        return job;
    }

    private void Start(bool share, bool start = false, string? projects = null)
    {
        var settings = _store.WithToken(
            new DesktopSettings
            {
                Address = _server.BaseUri.ToString(),
                ShareCodeJobs = share,
                CodeJobsFolder = _jobs.Jobs,
                StartCodeJobs = start,
                CodeProjectsFolder = projects,
            },
            FakeAnemoServer.Token);
        _store.Save(settings);
        Agent = new DesktopAgent(new DesktopAgentParts(
            _store,
            _platform.Services,
            new CommandLog(Path.Combine(_jobs.Root, "log"), TimeProvider.System),
            _log,
            TimeProvider.System,
            _http,
            "1.1.0",
            @"C:\Users\me\AnemoWork",
            new DeviceConnectionOptions { Backoff = () => new Backoff(TimeSpan.FromMilliseconds(50), TimeSpan.FromMilliseconds(200)) },
            new Core.Commands.CommandOptions { SettleDelay = TimeSpan.Zero, OpenDelay = TimeSpan.Zero },
            _processes,
            new CodeJobsOptions { PollInterval = TimeSpan.FromMilliseconds(50) },
            _host));
        _running = Agent.RunAsync(_stop.Token);
    }

    private static async Task WaitForAsync(Func<bool> condition)
    {
        var until = DateTime.UtcNow.AddSeconds(10);
        while (!condition())
        {
            if (DateTime.UtcNow > until)
            {
                throw new TimeoutException("condition not met");
            }

            await Task.Delay(20);
        }
    }
}
