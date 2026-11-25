using Anemo.Desktop.Tests.Fakes;
using Anemo.Desktop.Core.Storage;
using Anemo.Desktop.Core.Updates;
using static Anemo.Desktop.Tests.Updates.UpdateBytes;

namespace Anemo.Desktop.Tests.Updates;

/// <summary>The updater against a fake GitHub and a fake host: when it checks, what it downloads, what it refuses, when it restarts.</summary>
public sealed class UpdaterTests : IDisposable
{
    private const string Exe = "Anemo-Desktop-win-x64.exe";
    private const string Sums = "SHA256SUMS-desktop.txt";
    private static readonly byte[] NewExe = Text("the 1.9.0 exe");

    private readonly string _folder = Path.Combine(Path.GetTempPath(), "anemo-updater-tests", Guid.NewGuid().ToString("N"));
    private readonly FakeReleaseFeed _feed = new();
    private readonly FakeUpdatePlatform _platform;
    private readonly ManualTime _time = new();
    private readonly ListLog _log = new();
    private DesktopSettings _settings = new();
    private string? _busy;

    public UpdaterTests()
    {
        Directory.CreateDirectory(_folder);
        _platform = new FakeUpdatePlatform(_folder);
    }

    public void Dispose()
    {
        if (Directory.Exists(_folder))
        {
            Directory.Delete(_folder, true);
        }
    }

    [Fact]
    public async Task The_first_check_comes_a_minute_after_start_then_every_six_hours()
    {
        Release("desktop-v1.8.0");
        var updater = Create();

        await updater.TickAsync(default);
        Assert.Empty(_feed.SentETags);

        _time.Now += TimeSpan.FromMinutes(1);
        await updater.TickAsync(default);
        Assert.Single(_feed.SentETags);
        Assert.Equal(UpdatePhase.UpToDate, updater.State.Phase);

        _time.Now += TimeSpan.FromHours(5);
        await updater.TickAsync(default);
        Assert.Single(_feed.SentETags);

        _time.Now += TimeSpan.FromHours(1);
        await updater.TickAsync(default);
        Assert.Equal([null, "\"v1\""], _feed.SentETags); // the second asks with the ETag
        Assert.Equal(UpdatePhase.UpToDate, updater.State.Phase); // 304: the cached list still says so
    }

    [Fact]
    public async Task A_newer_release_is_downloaded_checked_and_ready()
    {
        Release("desktop-v1.9.0");
        var updater = Create();

        await updater.CheckNowAsync(default);

        Assert.Equal(new UpdateState(UpdatePhase.Ready, new AppVersion(1, 9, 0), CheckedAt: _time.Now), updater.State);
        Assert.Equal(NewExe, File.ReadAllBytes(_platform.Staged));
        Assert.False(File.Exists(_platform.DownloadPath));
        Assert.Equal(new AppVersion(1, 9, 0), updater.Ready!.Version);
        Assert.Equal("Update to 1.9.0 ready: Restart to update", UpdateText.MenuItem(updater.State));
    }

    [Fact]
    public async Task A_download_that_does_not_match_its_checksum_is_deleted_and_refused()
    {
        Release("desktop-v1.9.0", exe: Text("something else"));
        var updater = Create();

        await updater.CheckNowAsync(default);

        Assert.Equal(UpdatePhase.Failed, updater.State.Phase);
        Assert.Contains("didn't match the release's checksum", updater.State.Message);
        Assert.Null(updater.Ready);
        Assert.False(File.Exists(_platform.DownloadPath));
        Assert.False(File.Exists(_platform.Staged));
    }

    [Fact]
    public async Task A_checksum_file_without_this_computers_file_is_refused()
    {
        _feed.Add("desktop-v1.9.0", files: [(Exe, NewExe), (Sums, Text($"{Sha256(NewExe)}  Anemo-Desktop-win-arm64.exe\n"))]);
        var updater = Create();

        await updater.CheckNowAsync(default);

        Assert.Equal(UpdatePhase.Failed, updater.State.Phase);
        Assert.Empty(_feed.Downloaded);
    }

    [Fact]
    public async Task What_the_platform_refuses_is_not_ready()
    {
        Release("desktop-v1.9.0");
        _platform.Refuse = "The new app is signed by another developer.";
        var updater = Create();

        await updater.CheckNowAsync(default);

        Assert.Equal(new UpdateState(UpdatePhase.Failed, Message: "The new app is signed by another developer.", CheckedAt: _time.Now), updater.State);
        Assert.False(File.Exists(_platform.DownloadPath));
    }

    [Fact]
    public async Task With_a_key_an_unsigned_release_is_refused_before_anything_is_downloaded()
    {
        using var key = new TestSigningKey();
        Release("desktop-v1.9.0");
        var updater = Create(key.PublicKey);

        await updater.CheckNowAsync(default);

        Assert.Equal(UpdatePhase.Failed, updater.State.Phase);
        Assert.Contains("isn't signed", updater.State.Message);
        Assert.Empty(_feed.Downloaded);
    }

    [Fact]
    public async Task With_a_key_a_wrong_signature_is_refused_and_a_right_one_accepted()
    {
        using var key = new TestSigningKey();
        using var other = new TestSigningKey();
        var sums = Text($"{Sha256(NewExe)}  {Exe}\n");
        _feed.Add("desktop-v1.9.0", files: [(Exe, NewExe), (Sums, sums), (Sums + ".sig", other.Sign("desktop-v1.9.0", sums))]);
        var updater = Create(key.PublicKey);

        await updater.CheckNowAsync(default);
        Assert.Contains("signature doesn't match", updater.State.Message);
        Assert.Empty(_feed.Downloaded);

        _feed.Files["desktop-v1.9.0/" + Sums + ".sig"] = key.Sign("desktop-v1.9.0", sums);
        await updater.CheckNowAsync(default);
        Assert.Equal(UpdatePhase.Ready, updater.State.Phase);
    }

    [Fact]
    public async Task A_signature_of_another_release_does_not_count()
    {
        using var key = new TestSigningKey();
        var sums = Text($"{Sha256(NewExe)}  {Exe}\n");
        _feed.Add("desktop-v1.9.0", files: [(Exe, NewExe), (Sums, sums), (Sums + ".sig", key.Sign("desktop-v1.7.0", sums))]);
        var updater = Create(key.PublicKey);

        await updater.CheckNowAsync(default);

        Assert.Equal(UpdatePhase.Failed, updater.State.Phase);
    }

    [Fact]
    public async Task Turned_off_it_never_checks_by_itself()
    {
        Release("desktop-v1.9.0");
        _settings = _settings with { AutoUpdate = false };
        var updater = Create();

        _time.Now += TimeSpan.FromDays(3);
        await updater.TickAsync(default);

        Assert.Empty(_feed.SentETags);
        Assert.Equal(UpdatePhase.Idle, updater.State.Phase);
        Assert.Equal("Automatic updates are off. Check now looks once.", UpdateText.Status(updater.State, false, "1.8.0"));
    }

    [Fact]
    public async Task Turned_off_check_now_still_checks_and_what_it_got_stays()
    {
        Release("desktop-v1.9.0");
        _settings = _settings with { AutoUpdate = false };
        var updater = Create();

        await updater.CheckNowAsync(default);
        await updater.TickAsync(default);

        Assert.Equal(UpdatePhase.Ready, updater.State.Phase);
    }

    [Fact]
    public async Task Turning_it_off_discards_an_update_it_fetched_by_itself()
    {
        Release("desktop-v1.9.0");
        var updater = Create();
        _time.Now += TimeSpan.FromMinutes(1);
        await updater.TickAsync(default);
        Assert.Equal(UpdatePhase.Ready, updater.State.Phase);

        _settings = _settings with { AutoUpdate = false };
        await updater.TickAsync(default);

        Assert.Equal(UpdatePhase.Idle, updater.State.Phase);
        Assert.Null(updater.Ready);
        Assert.False(File.Exists(_platform.Staged));
    }

    [Fact]
    public async Task A_version_that_failed_to_start_is_not_fetched_again_by_itself_but_check_now_tries()
    {
        Release("desktop-v1.9.0");
        Directory.CreateDirectory(Path.Combine(_folder, "updates"));
        File.WriteAllText(Path.Combine(_folder, "updates", "failed"), "1.9.0");
        var updater = Create();

        _time.Now += TimeSpan.FromMinutes(1);
        await updater.TickAsync(default);
        Assert.Equal(UpdatePhase.Failed, updater.State.Phase);
        Assert.Contains("didn't start", updater.State.Message);
        Assert.Empty(_feed.Downloaded);

        await updater.CheckNowAsync(default);
        Assert.Equal(UpdatePhase.Ready, updater.State.Phase);
    }

    [Fact]
    public async Task GitHub_out_of_reach_is_tried_again_after_an_hour()
    {
        _feed.ListFails = new ReleaseFeedException("GitHub couldn't be reached.");
        var updater = Create();
        _time.Now += TimeSpan.FromMinutes(1);
        await updater.TickAsync(default);
        Assert.Equal(new UpdateState(UpdatePhase.Failed, Message: "GitHub couldn't be reached."), updater.State);

        _feed.ListFails = null;
        Release("desktop-v1.8.0");
        _time.Now += TimeSpan.FromMinutes(59);
        await updater.TickAsync(default);
        Assert.Single(_feed.SentETags);

        _time.Now += TimeSpan.FromMinutes(1);
        await updater.TickAsync(default);
        Assert.Equal(UpdatePhase.UpToDate, updater.State.Phase);
    }

    [Fact]
    public async Task A_ready_update_is_not_downloaded_again_and_a_newer_one_replaces_it()
    {
        Release("desktop-v1.9.0");
        var updater = Create();
        await updater.CheckNowAsync(default);
        await updater.CheckNowAsync(default);
        Assert.Single(_feed.Downloaded);

        var newer = Text("the 1.9.1 exe");
        _feed.ETag = "\"v2\"";
        Release("desktop-v1.9.1", exe: newer, sumsOf: newer);
        await updater.CheckNowAsync(default);

        Assert.Equal(new AppVersion(1, 9, 1), updater.Ready!.Version);
        Assert.Equal(newer, File.ReadAllBytes(_platform.Staged));
    }

    [Fact]
    public async Task Restart_to_update_waits_until_the_agent_is_done()
    {
        Release("desktop-v1.9.0");
        var updater = Create();
        await updater.CheckNowAsync(default);
        var restarts = new List<StagedUpdate>();
        updater.RestartRequested += restarts.Add;
        _busy = "a Claude Code job is running";

        Assert.True(updater.RestartToUpdate());
        await updater.TickAsync(default);

        Assert.Empty(restarts);
        Assert.Equal(new UpdateState(UpdatePhase.WaitingToRestart, new AppVersion(1, 9, 0), "a Claude Code job is running", _time.Now), updater.State);
        Assert.Contains("once nothing is running (a Claude Code job is running)", UpdateText.Status(updater.State, true, "1.8.0"));

        _busy = null;
        await updater.TickAsync(default);
        await updater.TickAsync(default);

        Assert.Single(restarts); // once
        Assert.Equal(new AppVersion(1, 9, 0), restarts[0].Version);
    }

    [Fact]
    public async Task Restart_when_idle_happens_at_once_and_needs_a_ready_update()
    {
        var updater = Create();
        Assert.False(updater.RestartToUpdate());

        Release("desktop-v1.9.0");
        await updater.CheckNowAsync(default);
        var restarts = 0;
        updater.RestartRequested += _ => restarts++;

        Assert.True(updater.RestartToUpdate());
        Assert.Equal(1, restarts);
    }

    [Fact]
    public async Task The_ready_update_is_taken_once_for_the_install_at_quit()
    {
        Release("desktop-v1.9.0");
        var updater = Create();
        await updater.CheckNowAsync(default);

        Assert.NotNull(updater.TakeReady());
        Assert.Null(updater.TakeReady());
    }

    [Fact]
    public async Task A_copy_that_cannot_update_never_asks_GitHub()
    {
        _platform.Unavailable = "This is a development build.";
        var updater = Create();

        await updater.CheckNowAsync(default);
        _time.Now += TimeSpan.FromDays(1);
        await updater.TickAsync(default);
        await updater.RunAsync(new CancellationToken(canceled: true));

        Assert.Empty(_feed.SentETags);
        Assert.Equal(new UpdateState(UpdatePhase.Unavailable, Message: "This is a development build."), updater.State);
        Assert.Equal(0, _platform.CleanUps);
    }

    [Theory]
    [InlineData("1.8.0-dev")]
    [InlineData("1.8")]
    public void A_version_that_is_not_a_release_does_not_update(string version)
    {
        var updater = Create(version: version);

        Assert.Equal(UpdatePhase.Unavailable, updater.State.Phase);
    }

    [Fact]
    public void A_damaged_compiled_in_key_turns_updates_off_and_says_so()
    {
        var updater = Create(publicKey: "not a key");

        Assert.Equal(UpdatePhase.Unavailable, updater.State.Phase);
        Assert.Contains("update key is damaged", updater.State.Message);
    }

    [Fact]
    public void The_texts_say_what_happens()
    {
        var v = new AppVersion(1, 9, 0);
        Assert.Equal("Checks GitHub for a new version at start and every 6 hours.", UpdateText.Status(new UpdateState(UpdatePhase.Idle), true, "1.8.0"));
        Assert.Equal("1.9.0 is ready: it is installed when you quit, or now with Restart to update.", UpdateText.Status(new UpdateState(UpdatePhase.Ready, v), true, "1.8.0"));
        Assert.Equal("update to 1.9.0 ready", UpdateText.Tooltip(new UpdateState(UpdatePhase.Ready, v)));
        Assert.Null(UpdateText.MenuItem(new UpdateState(UpdatePhase.UpToDate)));
        Assert.Null(UpdateText.Tooltip(new UpdateState(UpdatePhase.Downloading, v)));
    }

    private void Release(string tag, byte[]? exe = null, byte[]? sumsOf = null) =>
        _feed.Add(tag, files: [(Exe, exe ?? NewExe), (Sums, Text($"{Sha256(sumsOf ?? NewExe)} *{Exe}\n"))]);

    private Updater Create(string? publicKey = null, string version = "1.8.0") => new(
        () => _settings,
        _platform,
        _feed,
        new UpdateInstaller(DiskUpdateFiles.Instance, _platform.Launcher, _log, Path.Combine(_folder, "updates")),
        version,
        new UpdateOptions { PublicKey = publicKey },
        _time,
        _log,
        () => _busy);
}
