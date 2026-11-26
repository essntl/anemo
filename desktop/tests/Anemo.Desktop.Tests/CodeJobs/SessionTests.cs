using System.Text;
using System.Text.Json.Nodes;
using Anemo.Desktop.Core.CodeJobs;
using Anemo.Desktop.Tests.Fakes;

namespace Anemo.Desktop.Tests.CodeJobs;

/// <summary>
/// One sharing session against the fake server-side store, with a fake clock and a temp
/// jobs folder: discovery, state, code.job rules, frames, acks and resending (§7.1, §7.2).
/// </summary>
public sealed class SessionTests : IDisposable
{
    private readonly JobsFolder _jobs = new();
    private readonly ManualTime _time = new();
    private readonly FakeProcesses _processes = new();
    private readonly ListLog _log = new();
    private readonly CodeJobStore _store;
    private readonly SessionHarness _h;

    public SessionTests()
    {
        _store = new CodeJobStore(_jobs.StateFile, _time, _log);
        _h = new SessionHarness(_jobs, _time, _processes, _store, _log);
    }

    private DateTimeOffset Now => _time.Now;

    public void Dispose() => _jobs.Dispose();

    [Fact]
    public async Task A_new_job_is_announced_first_and_its_events_follow_the_ack()
    {
        var job = Running(Now.AddMinutes(-1));
        job.Branch("feat/flaky-test");
        job.WriteTurn(2);

        await _h.StepAsync();
        var announce = JsonNode.Parse(Assert.Single(_h.Sent))!.AsObject();
        Assert.Equal("code.job", (string?)announce["type"]);
        var sent = announce["job"]!.AsObject();
        Assert.Equal(job.Id, (string?)sent["id"]);
        Assert.Equal(job.Folder, (string?)sent["device_job_dir"]);
        Assert.Equal("anemo", (string?)sent["project"]);
        Assert.Equal(job.Dir, (string?)sent["dir"]);
        Assert.Equal(job.Started.ToString("yyyy-MM-dd'T'HH:mm:ss.fffzzz"), (string?)sent["started"]);
        Assert.Equal("Fix the flaky test.\nThen open a PR.", (string?)sent["prompt"]);
        Assert.Null(sent["resume_session"]);
        Assert.Null(sent["model"]);
        Assert.Equal(4242, (int?)sent["pid"]);
        Assert.Equal("running", (string?)sent["state"]);
        Assert.Null(sent["ended"]);
        Assert.Equal("feat/flaky-test", (string?)sent["branch"]);
        Assert.Null(sent["stderr_tail"]);
        Assert.False((bool)sent["input"]!); // a job of cc.ps1 takes no messages while it runs (§15)
        Assert.Equal(14, sent.Count);

        // Nothing more before the ack.
        await _h.StepAsync();
        Assert.Single(_h.Sent);

        _h.Deliver(); // ack 0
        await _h.StepAsync();
        var frame = _h.SentOf("code.events").Single();
        Assert.Equal(job.Id, (string?)frame["job_id"]);
        var items = frame["events"]!.AsArray();
        Assert.Equal([1L, 2, 3, 4, 5, 6, 7], items.Select(i => (long)i!["seq"]!));
        Assert.All(items, i => Assert.False((bool)i!["trimmed"]!));
        Assert.Equal("system", (string?)items[0]!["event"]!["type"]);
        Assert.Equal(3, items[0]!.AsObject().Count);

        _h.Deliver(); // ack 7
        await _h.StepAsync();
        Assert.Equal(2, _h.Sent.Count);

        job.Write(CodeEvents.Text("More."));
        await _h.StepAsync();
        Assert.Equal([8L], _h.SentOf("code.events").Last()["events"]!.AsArray().Select(i => (long)i!["seq"]!));
    }

    [Fact]
    public async Task One_frame_in_flight_per_job_and_at_most_200_events_each()
    {
        var job = Running(Now.AddMinutes(-1));
        job.Write(Enumerable.Range(0, 450).Select(i => CodeEvents.Text($"line {i}")).ToArray());

        await _h.StepAsync();
        _h.Deliver();
        await _h.StepAsync();
        await _h.StepAsync(); // waits for the ack
        Assert.Single(_h.SentOf("code.events"));

        await _h.SettleAsync();

        var frames = _h.SentOf("code.events").Select(f => f["events"]!.AsArray()).ToList();
        Assert.Equal([200, 200, 50], frames.Select(f => f.Count));
        Assert.Equal(Enumerable.Range(1, 450).Select(i => (long)i), frames.SelectMany(f => f).Select(i => (long)i!["seq"]!));
        Assert.Equal(450, _h.Server.Jobs[job.Id].LastSeq);
    }

    [Fact]
    public async Task A_frame_holds_at_most_256_KB_of_UTF_8()
    {
        var job = Running(Now.AddMinutes(-1));
        job.Write(Enumerable.Range(0, 40).Select(_ => CodeEvents.Sized(15_000)).ToArray());

        await _h.SettleAsync();

        var frames = _h.Sent.Where(t => t.StartsWith("{\"type\":\"code.events\"", StringComparison.Ordinal)).ToList();
        Assert.True(frames.Count >= 3);
        Assert.All(frames, f => Assert.True(Encoding.UTF8.GetByteCount(f) <= 256 * 1024));
        Assert.True(Encoding.UTF8.GetByteCount(frames[0]) > 200 * 1024); // filled, not one event each
        Assert.Equal(40, _h.Server.Jobs[job.Id].LastSeq);
    }

    [Fact]
    public async Task A_job_that_ends_sends_its_remaining_events_before_the_terminal_state()
    {
        var job = Running(Now.AddMinutes(-1));
        job.WriteTurn(1);
        await _h.SettleAsync();

        job.Write(CodeEvents.Text("Done."));
        job.Finish();
        job.Stderr("warning: something\n");
        _processes.Running.Clear();
        await _h.SettleAsync();

        Assert.Equal(
            [$"job:{job.Id}:running", $"events:{job.Id}:1-4", $"events:{job.Id}:5-6", $"job:{job.Id}:done"],
            _h.Server.Order);
        var final = _h.Server.Jobs[job.Id].Job!;
        Assert.NotNull((string?)final["ended"]);
        Assert.Equal("warning: something\n", (string?)final["stderr_tail"]);
        Assert.Equal(new JobRecord { AckedSeq = 6, AckedOffset = new FileInfo(job.OutPath).Length, SentState = "done", Settled = true }, _store.Get(job.Id));
        Assert.Empty(_h.Session.Following);
        Assert.Contains($"code job ended: {job.Id} (done)", _log.Lines);
    }

    [Fact]
    public async Task Only_running_jobs_count_as_running_not_ended_ones_waiting_for_an_ack()
    {
        var job = Running(Now.AddMinutes(-1));
        await _h.StepAsync();
        Assert.Equal(1, _h.Session.RunningCount);

        job.Finish();
        _processes.Running.Clear();
        await _h.StepAsync(); // no ack comes (offline): the job stays followed, but it ended

        Assert.Contains(job.Id, _h.Session.Following);
        Assert.Equal(0, _h.Session.RunningCount);
    }

    [Fact]
    public async Task A_settled_job_is_not_announced_again_after_a_reconnect_or_restart()
    {
        var job = Running(Now.AddMinutes(-1));
        job.WriteTurn(1);
        job.Finish();
        await _h.SettleAsync();
        Assert.True(_store.Get(job.Id)!.Settled);

        _h.Sent.Clear();
        _h.NewSession();
        await _h.SettleAsync();
        Assert.Empty(_h.Sent);

        // A restart reads the state file again.
        var restarted = new SessionHarness(_jobs, _time, _processes, new CodeJobStore(_jobs.StateFile, _time, _log), _log);
        await restarted.SettleAsync();
        Assert.Empty(restarted.Sent);
    }

    [Fact]
    public async Task After_a_reconnect_unsettled_jobs_are_announced_again_and_go_on_from_the_ack()
    {
        var job = Running(Now.AddMinutes(-1));
        job.Write(Enumerable.Range(0, 10).Select(i => CodeEvents.Text($"line {i}")).ToArray());
        await _h.SettleAsync();
        Assert.Equal(new JobRecord { AckedSeq = 10, AckedOffset = new FileInfo(job.OutPath).Length, SentState = "running" }, _store.Get(job.Id));

        // The connection drops while a frame is in flight; the server never got it.
        job.Write(Enumerable.Range(10, 5).Select(i => CodeEvents.Text($"line {i}")).ToArray());
        await _h.StepAsync();
        Assert.Single(_h.Pending);
        _h.NewSession();
        var before = _h.Sent.Count;

        await _h.StepAsync();
        var again = JsonNode.Parse(_h.Sent[before])!.AsObject();
        Assert.Equal("code.job", (string?)again["type"]);
        Assert.Equal(before + 1, _h.Sent.Count); // events only after the ack

        await _h.SettleAsync();
        Assert.Equal($"events:{job.Id}:11-15", _h.Server.Order.Last());
        Assert.Equal(15, _h.Server.Jobs[job.Id].LastSeq);
    }

    [Fact]
    public async Task The_server_s_ack_wins_also_when_it_is_lower_than_the_saved_one()
    {
        var job = Running(Now.AddMinutes(-1));
        job.Write(Enumerable.Range(0, 20).Select(i => CodeEvents.Text($"line {i}")).ToArray());
        await _h.SettleAsync();
        Assert.Equal(20, _store.Get(job.Id)!.AckedSeq);

        // The server's database was restored: it has events 1–8 only.
        var restored = new FakeCodeServer();
        var old = _h.Server.Jobs[job.Id];
        var kept = restored.Jobs.GetOrAdd(job.Id, _ => new FakeCodeServer.ServerJob());
        kept.Job = old.Job;
        for (var seq = 1L; seq <= 8; seq++)
        {
            kept.Events[seq] = old.Events[seq];
        }

        kept.LastSeq = 8;
        _h.Server = restored;
        _h.NewSession();
        await _h.SettleAsync();

        Assert.Equal([$"job:{job.Id}:running", $"events:{job.Id}:9-20"], restored.Order);
        Assert.Equal(20, kept.LastSeq);
        Assert.Equal(20, _store.Get(job.Id)!.AckedSeq);
    }

    [Fact]
    public async Task A_server_that_lost_everything_gets_everything_again()
    {
        var job = Running(Now.AddMinutes(-1));
        job.WriteTurn(3);
        await _h.SettleAsync();

        _h.Server = new FakeCodeServer();
        _h.NewSession();
        await _h.SettleAsync();

        Assert.Equal([$"job:{job.Id}:running", $"events:{job.Id}:1-10"], _h.Server.Order);
    }

    [Fact]
    public async Task A_damaged_state_file_starts_empty_and_the_server_s_ack_repairs_it()
    {
        var job = Running(Now.AddMinutes(-1));
        job.WriteTurn(2);
        await _h.SettleAsync();

        File.WriteAllText(_jobs.StateFile, "{\"jobs\": {\"x\": [garbage");
        var store = new CodeJobStore(_jobs.StateFile, _time, _log);
        var restarted = new SessionHarness(_jobs, _time, _processes, store, _log) { Server = _h.Server };
        job.Write(CodeEvents.Text("after the restart"));
        await restarted.SettleAsync();

        Assert.Contains("code jobs state file unreadable; starting empty", _log.Lines);
        Assert.Equal($"events:{job.Id}:8-8", _h.Server.Order.Last()); // only the new one, from the server's ack
        Assert.Equal(8, store.Get(job.Id)!.AckedSeq);
        Assert.False(File.Exists(_jobs.StateFile + ".tmp"));
    }

    [Fact]
    public async Task A_job_seen_for_the_first_time_after_it_ended_is_announced_with_its_terminal_state()
    {
        var job = _jobs.Add(Now.AddHours(-5)); // its process is gone
        job.WriteTurn(1);
        job.Finish();

        await _h.SettleAsync();

        Assert.Equal([$"job:{job.Id}:done", $"events:{job.Id}:1-5", $"job:{job.Id}:done"], _h.Server.Order);
        Assert.DoesNotContain("running", _h.Server.Jobs[job.Id].States); // no notification for a back-fill (D10)
        Assert.True(_store.Get(job.Id)!.Settled);
    }

    [Fact]
    public async Task A_job_that_ended_while_disconnected_keeps_the_last_state_the_server_knew_until_its_events_are_in()
    {
        var job = Running(Now.AddMinutes(-1));
        job.WriteTurn(1);
        await _h.SettleAsync();
        _h.NewSession();

        job.Write(CodeEvents.Text("finished meanwhile"));
        job.Finish(error: true, subtype: "error_max_turns");
        _processes.Running.Clear();
        await _h.SettleAsync();

        Assert.Equal(
            [$"job:{job.Id}:running", $"events:{job.Id}:1-4", $"job:{job.Id}:running", $"events:{job.Id}:5-6", $"job:{job.Id}:failed"],
            _h.Server.Order);
    }

    [Theory]
    [InlineData("running")]
    [InlineData("done")]
    [InlineData("failed")]
    [InlineData("failed_by_subtype")]
    [InlineData("cancelled")]
    [InlineData("cancelled_after_result")]
    [InlineData("exited_without_result")]
    [InlineData("pid_reused")]
    [InlineData("start_time_unknown")]
    public async Task The_state_follows_the_folder_and_the_process(string scenario)
    {
        var started = Now.AddMinutes(-3);
        var job = _jobs.Add(started);
        job.WriteTurn(1);
        var expected = scenario;
        switch (scenario)
        {
            case "running":
                _processes.Running[4242] = started.AddSeconds(-1);
                break;
            case "done":
                job.Finish();
                break;
            case "failed":
                job.Finish(error: true, subtype: "success");
                break;
            case "failed_by_subtype":
                job.Finish(error: false, subtype: "error_during_execution");
                expected = "failed";
                break;
            case "cancelled":
                job.Cancel();
                break;
            case "cancelled_after_result":
                job.Finish();
                job.Cancel();
                expected = "cancelled";
                break;
            case "pid_reused":
                _processes.Running[4242] = started.AddMinutes(2);
                expected = "exited_without_result";
                break;
            case "start_time_unknown":
                _processes.Running[4242] = null;
                SetLastOutput(job, Now.AddMinutes(-1)); // wrote a minute ago
                expected = "running";
                break;
        }

        await _h.StepAsync();

        var sent = JsonNode.Parse(Assert.Single(_h.Sent))!["job"]!;
        Assert.Equal(expected, (string?)sent["state"]);
        Assert.Equal(expected == "running", sent["ended"] is null);
    }

    [Fact]
    public async Task A_job_whose_process_can_t_be_read_ends_after_30_minutes_without_output()
    {
        // The pid now belongs to an elevated or another user's process: nothing about it can be read.
        var job = _jobs.Add(Now.AddHours(-2));
        _processes.Running[4242] = null;
        job.WriteTurn(1);
        job.Stderr("still working");
        SetLastOutput(job, Now.AddMinutes(-10));
        await _h.SettleAsync();
        Assert.Equal("running", (string?)_h.Server.Jobs[job.Id].Job!["state"]);

        // err.txt counts as output too.
        _time.Now += TimeSpan.FromMinutes(25);
        File.SetLastWriteTimeUtc(Path.Combine(job.Folder, "err.txt"), Now.AddMinutes(-2).UtcDateTime);
        await _h.SettleAsync();
        Assert.Equal("running", (string?)_h.Server.Jobs[job.Id].Job!["state"]);

        _time.Now += TimeSpan.FromMinutes(31);
        await _h.SettleAsync();

        Assert.Equal("exited_without_result", (string?)_h.Server.Jobs[job.Id].Job!["state"]);
        Assert.True(_store.Get(job.Id)!.Settled);
    }

    [Fact]
    public async Task A_running_job_becomes_exited_without_result_when_its_process_is_gone()
    {
        var job = Running(Now.AddMinutes(-1));
        job.WriteTurn(1);
        job.Stderr("Error: API key invalid");
        await _h.SettleAsync();

        _processes.Running.Clear();
        await _h.SettleAsync();

        var last = _h.Server.Jobs[job.Id].Job!;
        Assert.Equal("exited_without_result", (string?)last["state"]);
        Assert.Equal("Error: API key invalid", (string?)last["stderr_tail"]);
        Assert.True(_store.Get(job.Id)!.Settled);
    }

    [Fact]
    public async Task A_change_of_branch_or_pid_sends_code_job_again()
    {
        var job = Running(Now.AddMinutes(-1));
        await _h.SettleAsync();

        job.Branch("feat/new-branch");
        await _h.SettleAsync();
        Assert.Equal("feat/new-branch", (string?)_h.Server.Jobs[job.Id].Job!["branch"]);

        var meta = JsonNode.Parse(File.ReadAllText(Path.Combine(job.Folder, "meta.json")))!.AsObject();
        meta["pid"] = 5151;
        File.WriteAllText(Path.Combine(job.Folder, "meta.json"), meta.ToJsonString());
        _processes.Running[5151] = job.Started;
        await _h.SettleAsync();
        Assert.Equal(5151, (int?)_h.Server.Jobs[job.Id].Job!["pid"]);

        Assert.Equal(3, _h.Server.Jobs[job.Id].States.Count);
        Assert.All(_h.Server.Jobs[job.Id].States, s => Assert.Equal("running", s));
    }

    [Fact]
    public async Task Raw_and_blank_lines_keep_the_numbering_without_holes()
    {
        var job = Running(Now.AddMinutes(-1));
        job.WriteRaw("\n" + CodeEvents.Init("s") + "\n\nnode: warning, not JSON\n   \n" + CodeEvents.Text("hi") + "\n{\"type\":\"assistant\",");

        await _h.SettleAsync();

        var stored = _h.Server.Jobs[job.Id].Events;
        Assert.Equal([1L, 2, 3], stored.Keys);
        Assert.Equal("""{"type":"raw","text":"node: warning, not JSON"}""", stored[2]["event"]!.ToJsonString());
        Assert.Equal("assistant", (string?)stored[3]["event"]!["type"]);

        // The half-written line goes once it is complete.
        job.WriteRaw("\"message\":{}}\n");
        await _h.SettleAsync();
        Assert.Equal([1L, 2, 3, 4], stored.Keys);
    }

    [Fact]
    public async Task Events_are_trimmed_before_they_are_sent()
    {
        var job = Running(Now.AddMinutes(-1));
        job.Write(CodeEvents.ReadResult("toolu_1", new string('r', 50_000)));

        await _h.SettleAsync();

        var item = _h.Server.Jobs[job.Id].Events[1];
        Assert.True((bool)item["trimmed"]!);
        Assert.True(EventTrimmer.CompactSize(item["event"]) <= CodeJobLimits.MaxEventBytes);
        Assert.Null(item["event"]!["tool_use_result"]!["file"]!["content"]);
    }

    [Fact]
    public async Task Only_jobs_of_the_last_3_days_are_back_filled_then_every_new_one()
    {
        var old = _jobs.Add(Now.AddDays(-5), suffix: "old1");
        var recent = _jobs.Add(Now.AddDays(-1), suffix: "rec1");
        old.Finish();
        recent.Finish();

        await _h.SettleAsync();
        Assert.NotNull(_store.SharedSince);
        Assert.True(_h.Server.Jobs.ContainsKey(recent.Id));
        Assert.False(_h.Server.Jobs.ContainsKey(old.Id));

        _time.Now += TimeSpan.FromHours(1);
        var fresh = Running(Now, suffix: "new1");
        await _h.SettleAsync();
        Assert.True(_h.Server.Jobs.ContainsKey(fresh.Id));
        Assert.False(_h.Server.Jobs.ContainsKey(old.Id));

        // A restart keeps the start of sharing: the old job stays out.
        var restarted = new SessionHarness(_jobs, _time, _processes, new CodeJobStore(_jobs.StateFile, _time, _log), _log) { Server = _h.Server };
        await restarted.SettleAsync();
        Assert.False(_h.Server.Jobs.ContainsKey(old.Id));
    }

    [Fact]
    public async Task Switching_sharing_off_and_on_again_back_fills_from_the_new_start()
    {
        var job = _jobs.Add(Now.AddDays(-2), suffix: "two2");
        job.Finish();
        _store.SetSharedSince(Now.AddDays(-30)); // shared long ago, then switched off…
        _store.SetSharedSince(null);
        _time.Now += TimeSpan.FromDays(2); // …and on again two days later: the job is 4 days old now

        await _h.SettleAsync();

        Assert.Empty(_h.Sent);
        Assert.True(_store.SharedSince > Now.AddMinutes(-5));
    }

    [Fact]
    public async Task Jobs_older_than_14_days_are_forgotten_and_not_discovered_again()
    {
        _store.SetSharedSince(Now.AddDays(-30));
        var job = _jobs.Add(Now.AddDays(-13));
        job.Finish();
        _store.Put("20261101-080000-gone", new JobRecord { AckedSeq = 3, AckedOffset = 90, SentState = "done", Settled = true });
        await _h.SettleAsync();
        Assert.True(_store.Get(job.Id)!.Settled);
        Assert.Null(_store.Get("20261101-080000-gone")); // 21 days old

        _time.Now += TimeSpan.FromDays(2);
        _h.Sent.Clear();
        _h.NewSession();
        await _h.SettleAsync();

        Assert.Null(_store.Get(job.Id));
        Assert.Empty(_h.Sent);
    }

    [Fact]
    public async Task No_ack_within_60_s_ends_the_session_to_reconnect()
    {
        var job = Running(Now.AddMinutes(-1));
        job.WriteTurn(1);
        await _h.SettleAsync();

        job.Write(CodeEvents.Text("one more"));
        _h.Server.Silent = true;
        await _h.StepAsync();
        _h.Deliver();
        _time.Now += TimeSpan.FromSeconds(59);
        Assert.Null(await _h.Session.StepAsync()); // 59 s: still waiting

        _time.Now += TimeSpan.FromSeconds(2);
        Assert.Equal(CodeJobsEnd.AckTimeout, await _h.Session.StepAsync());
    }

    [Fact]
    public async Task Unanswered_counts_the_messages_still_waiting_for_an_ack()
    {
        var first = Running(Now.AddMinutes(-1), suffix: "one1");
        var second = Running(Now.AddMinutes(-2), suffix: "two2");

        await _h.StepAsync();
        Assert.Equal(new Dictionary<string, int> { [first.Id] = 1, [second.Id] = 1 }, new Dictionary<string, int>(_h.Session.Unanswered()));

        // An ack that came but wasn't applied yet answers its message.
        _h.Session.OnAck(first.Id, 0);
        Assert.Equal(new Dictionary<string, int> { [second.Id] = 1 }, new Dictionary<string, int>(_h.Session.Unanswered()));
    }

    [Fact]
    public async Task A_message_that_could_not_be_sent_waits_for_no_ack()
    {
        var job = Running(Now.AddMinutes(-1));
        var session = new CodeJobsSession(_jobs.Jobs, _store, _processes, _time, _log, new CodeJobsOptions(),
            (_, _) => throw new OperationCanceledException());

        await Assert.ThrowsAsync<OperationCanceledException>(() => session.StepAsync());

        Assert.Empty(session.Unanswered());
        Assert.Contains(job.Id, session.Following);
    }

    [Fact]
    public async Task A_server_that_never_acks_is_not_reconnected_to_forever()
    {
        _h.Server.Silent = true;
        Running(Now.AddMinutes(-1));
        await _h.StepAsync();
        _h.Deliver();

        _time.Now += TimeSpan.FromSeconds(61);

        Assert.Equal(CodeJobsEnd.NeverAcked, await _h.Session.StepAsync());
    }

    [Fact]
    public async Task A_back_fill_goes_out_a_few_jobs_at_a_time_and_a_running_job_first()
    {
        for (var i = 0; i < 6; i++)
        {
            _jobs.Add(Now.AddHours(-10 - i), suffix: $"bf{i:00}").Finish();
        }

        var live = Running(Now.AddMinutes(-1), suffix: "live");

        await _h.StepAsync();

        Assert.Equal(4, _h.Pending.Count);
        Assert.Equal(live.Id, (string?)JsonNode.Parse(_h.Sent[0])!["job"]!["id"]);
        await _h.SettleAsync();
        Assert.Equal(7, _h.Server.Jobs.Count);
    }

    [Fact]
    public async Task Code_job_cuts_the_prompt_to_20000_characters_and_the_stderr_tail_to_4000()
    {
        var job = _jobs.Add(Now.AddMinutes(-2), prompt: new string('p', 30_000));
        job.Stderr(string.Concat(Enumerable.Repeat("\u001b[31mred\u001b[0m", 800)));
        job.Finish(error: true);

        await _h.StepAsync();

        var sent = JsonNode.Parse(_h.Sent[0])!["job"]!;
        Assert.Equal(20_000, ((string?)sent["prompt"])!.Length);
        Assert.Equal(4000, ((string?)sent["stderr_tail"])!.Length);
    }

    [Fact]
    public async Task Code_job_fits_64000_characters_even_when_escapes_make_it_long()
    {
        // Every control character is six characters on the wire (\u0001).
        var job = _jobs.Add(Now.AddMinutes(-2), prompt: new string('\u0001', 20_000));
        job.Stderr(new string('\u0002', 4000));
        job.Finish(error: true);

        await _h.StepAsync();

        var text = _h.Sent[0];
        Assert.True(text.Length <= CodeJobLimits.MaxJobMessageChars);
        Assert.NotEmpty(((string?)JsonNode.Parse(text)!["job"]!["prompt"])!);
    }

    [Fact]
    public async Task The_log_has_ids_and_counts_never_contents()
    {
        var job = _jobs.Add(Now.AddMinutes(-1), prompt: "SECRET-PROMPT do the thing");
        _processes.Running[4242] = job.Started;
        job.Write(CodeEvents.Text("SECRET-OUTPUT"), CodeEvents.Bash("toolu_1", "echo SECRET-COMMAND"));
        job.Stderr("SECRET-STDERR");
        await _h.SettleAsync();
        job.Finish();
        await _h.SettleAsync();

        Assert.Contains($"code job discovered: {job.Id}", _log.Lines);
        Assert.Contains($"code job ended: {job.Id} (done)", _log.Lines);
        Assert.DoesNotContain(_log.Lines, l => l.Contains("SECRET", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_missing_jobs_folder_sends_nothing()
    {
        Directory.Delete(_jobs.Jobs, true);

        await _h.SettleAsync();

        Assert.Empty(_h.Sent);
    }

    [Fact]
    public async Task A_folder_without_a_readable_meta_json_is_taken_once_it_reads()
    {
        var job = Running(Now.AddMinutes(-1));
        var meta = Path.Combine(job.Folder, "meta.json");
        var text = File.ReadAllText(meta);
        File.WriteAllText(meta, text[..10]);

        await _h.SettleAsync();
        Assert.Empty(_h.Sent);

        File.WriteAllText(meta, text);
        await _h.SettleAsync();
        Assert.True(_h.Server.Jobs.ContainsKey(job.Id));
    }

    /// <summary>out.jsonl and err.txt last written then (the fake clock is not the files' clock).</summary>
    private static void SetLastOutput(FakeJob job, DateTimeOffset at)
    {
        File.SetLastWriteTimeUtc(job.OutPath, at.UtcDateTime);
        File.SetLastWriteTimeUtc(Path.Combine(job.Folder, "err.txt"), at.UtcDateTime);
    }

    private FakeJob Running(DateTimeOffset started, string suffix = "ab12")
    {
        var job = _jobs.Add(started, suffix: suffix);
        _processes.Running[4242] = started;
        return job;
    }
}
