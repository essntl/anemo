using System.Text.Json.Nodes;
using Anemo.Desktop.Core.CodeJobs;
using Anemo.Desktop.Core.Protocol;
using Anemo.Desktop.Core.Storage;
using Anemo.Desktop.Tests.Fakes;

namespace Anemo.Desktop.Tests.CodeJobs;

/// <summary>The switch and the trust check around the sessions (code-sessions.md D4).</summary>
public sealed class SharingTests : IDisposable
{
    private static readonly DeviceInfo Trusted = new("dev-1", "Desk PC", "computer", "trusted");
    private static readonly DeviceInfo Watched = new("dev-1", "Desk PC", "computer", "watched");

    private readonly JobsFolder _jobs = new();
    private readonly FakeProcesses _processes = new();
    private readonly ListLog _log = new();
    private readonly FakeLink _link = new();
    private readonly CancellationTokenSource _stop = new();
    private DesktopSettings _settings;

    public SharingTests()
    {
        _settings = new DesktopSettings { ShareCodeJobs = true, CodeJobsFolder = _jobs.Jobs };
    }

    public void Dispose()
    {
        _stop.Cancel();
        _jobs.Dispose();
    }

    [Fact]
    public void The_offer_says_code_only_when_sharing_is_on_and_the_device_is_trusted()
    {
        var sharing = Create();
        Assert.True(sharing.Offered(Trusted));
        Assert.False(sharing.Offered(Watched));

        _settings = _settings with { ShareCodeJobs = false };
        Assert.False(sharing.Offered(Trusted));
    }

    [Fact]
    public async Task Nothing_is_sent_while_sharing_is_off()
    {
        _settings = _settings with { ShareCodeJobs = false };
        AddJob();
        var sharing = Create();

        var run = sharing.RunAsync(_link, Trusted, _stop.Token);
        await Task.Delay(300);

        Assert.Empty(_link.Sent);
        Assert.False(run.IsCompleted);
    }

    [Fact]
    public async Task Nothing_is_sent_for_a_watched_device()
    {
        AddJob();
        var sharing = Create();

        _ = sharing.RunAsync(_link, Watched, _stop.Token);
        await Task.Delay(300);

        Assert.Empty(_link.Sent);
        Assert.Null(sharing.Session);
    }

    [Fact]
    public async Task Switching_on_starts_sharing_and_switching_off_stops_it_without_a_reconnect()
    {
        _settings = _settings with { ShareCodeJobs = false };
        var job = AddJob();
        var sharing = Create();
        _ = sharing.RunAsync(_link, Trusted, _stop.Token);
        await Task.Delay(100);
        Assert.Empty(_link.Sent);

        _settings = _settings with { ShareCodeJobs = true };
        sharing.SettingsChanged();
        await WaitForAsync(() => _link.Sent.Count == 1);
        Assert.Equal("code.job", (string?)JsonNode.Parse(_link.Sent.Single())!["type"]);
        sharing.OnAck(FakeCodeServer.AckMessage(job.Id, 0));
        await WaitForAsync(() => _link.Sent.Count == 2);
        Assert.NotNull(sharing.Store.SharedSince);

        _settings = _settings with { ShareCodeJobs = false };
        sharing.SettingsChanged();
        await WaitForAsync(() => sharing.Session is null);
        job.Write(CodeEvents.Text("written after sharing was switched off"));
        await Task.Delay(300);

        Assert.Equal(2, _link.Sent.Count);
        Assert.Null(sharing.Store.SharedSince); // the next switch-on back-fills again
        Assert.Equal(0, _link.Drops);
    }

    [Fact]
    public async Task Another_jobs_folder_restarts_sharing_there()
    {
        var sharing = Create();
        _ = sharing.RunAsync(_link, Trusted, _stop.Token);
        await Task.Delay(100);
        Assert.Empty(_link.Sent);

        using var other = new JobsFolder();
        var job = other.Add(DateTimeOffset.UtcNow.AddMinutes(-1));
        _settings = _settings with { CodeJobsFolder = other.Jobs };
        sharing.SettingsChanged();

        await WaitForAsync(() => _link.Sent.Count == 1);
        Assert.Equal(job.Id, (string?)JsonNode.Parse(_link.Sent.Single())!["job"]!["id"]);
    }

    [Fact]
    public async Task No_ack_within_the_timeout_drops_the_connection()
    {
        var job = AddJob();
        var sharing = Create(new CodeJobsOptions { PollInterval = TimeSpan.FromMilliseconds(20), AckTimeout = TimeSpan.FromMilliseconds(300) });
        var run = sharing.RunAsync(_link, Trusted, _stop.Token);
        await WaitForAsync(() => _link.Sent.Count == 1);
        sharing.OnAck(FakeCodeServer.AckMessage(job.Id, 0)); // the code.job is answered, the events are not

        await run.WaitAsync(TimeSpan.FromSeconds(5));

        Assert.Equal(1, _link.Drops);
        Assert.Contains("code jobs: no ack within 60 s; reconnecting", _log.Lines);
    }

    [Fact]
    public async Task An_Anemo_that_never_acks_is_left_alone_instead_of_reconnecting()
    {
        AddJob();
        var sharing = Create(new CodeJobsOptions { PollInterval = TimeSpan.FromMilliseconds(20), AckTimeout = TimeSpan.FromMilliseconds(200) });
        var run = sharing.RunAsync(_link, Trusted, _stop.Token);

        await WaitForAsync(() => _log.Lines.Any(l => l.Contains("not sharing on this connection", StringComparison.Ordinal)));
        await Task.Delay(300);

        Assert.Equal(0, _link.Drops);
        Assert.Single(_link.Sent);
        Assert.False(run.IsCompleted);
    }

    [Fact]
    public void A_malformed_ack_is_ignored()
    {
        var sharing = Create();

        sharing.OnAck(new JsonObject { ["type"] = "code.ack", ["job_id"] = "x" });
        sharing.OnAck(new JsonObject { ["type"] = "code.ack", ["job_id"] = "x", ["seq"] = -1 });
        sharing.OnAck(new JsonObject { ["type"] = "code.ack", ["seq"] = 3 });
    }

    [Fact]
    public void Starting_with_sharing_off_forgets_when_sharing_started()
    {
        var store = new CodeJobStore(_jobs.StateFile, TimeProvider.System, _log);
        store.SetSharedSince(DateTimeOffset.UtcNow.AddDays(-10));
        _settings = _settings with { ShareCodeJobs = false };

        _ = new CodeJobSharing(() => _settings, store, _processes, TimeProvider.System, _log);

        Assert.Null(new CodeJobStore(_jobs.StateFile, TimeProvider.System, _log).SharedSince);
    }

    private FakeJob AddJob()
    {
        var job = _jobs.Add(DateTimeOffset.UtcNow.AddMinutes(-1));
        _processes.Running[4242] = job.Started;
        job.WriteTurn(1);
        return job;
    }

    private CodeJobSharing Create(CodeJobsOptions? options = null) => new(
        () => _settings,
        new CodeJobStore(_jobs.StateFile, TimeProvider.System, _log),
        _processes,
        TimeProvider.System,
        _log,
        options ?? new CodeJobsOptions { PollInterval = TimeSpan.FromMilliseconds(20) });

    private static async Task WaitForAsync(Func<bool> condition)
    {
        var until = DateTime.UtcNow.AddSeconds(5);
        while (!condition())
        {
            if (DateTime.UtcNow > until)
            {
                throw new TimeoutException("condition not met");
            }

            await Task.Delay(10);
        }
    }
}
