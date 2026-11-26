using System.Text.Json.Nodes;
using Anemo.Desktop.Core.CodeJobs;
using Anemo.Desktop.Core.Commands;
using Anemo.Desktop.Core.Control;
using Anemo.Desktop.Core.Protocol;
using Anemo.Desktop.Core.Storage;
using Anemo.Desktop.Tests.Fakes;

namespace Anemo.Desktop.Tests.CodeJobs;

/// <summary>Messages for a running job (code-sessions.md §15, 1.9.0): code_start with input, code_input, code_input_withdraw.</summary>
public sealed class CodeJobInputTests : IDisposable
{
    private static readonly DeviceInfo Trusted = new("dev-1", "Desk PC", "computer", "trusted");
    private const string Message = "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

    private readonly JobsFolder _jobs = new();
    private readonly ManualTime _time = new();
    private readonly FakeProcesses _processes = new();
    private readonly FakeCodeHost _host = FakeCodeHost.WithEverything();
    private readonly CommandProcessor _processor;
    private readonly string _projects;

    public CodeJobInputTests()
    {
        _projects = Path.Combine(_jobs.Root, "projects");
        Directory.CreateDirectory(Path.Combine(_projects, "anemo"));
        var settings = new DesktopSettings
        {
            ShareCodeJobs = true,
            StartCodeJobs = true,
            CodeJobsFolder = _jobs.Jobs,
            CodeProjectsFolder = _projects,
            GitHubOwner = "essntl",
        };
        var control = new ControlState(_time, allow: true, pausedUntil: null);
        var log = new CommandLog(Path.Combine(_jobs.Root, "log"), _time);
        var jobControl = new CodeJobControl(() => settings, _host, _processes, _time, new CodeJobControlOptions { NewIdSuffix = () => "k3x9" });
        _processor = new CommandProcessor(new FakePlatform().Services, control, () => settings, log, null, jobControl);
    }

    public void Dispose() => _jobs.Dispose();

    [Fact]
    public async Task A_job_started_with_input_reads_its_messages_from_the_feeder()
    {
        var outcome = await RunAsync("code_start", new JsonObject { ["project"] = "anemo", ["prompt"] = "Fix it.", ["input"] = true });

        Assert.True(outcome.Ok, outcome.Error);
        var id = (string)outcome.State!["job_id"]!;
        var folder = Path.Combine(_jobs.Jobs, id);
        Assert.Equal("Fix it.", File.ReadAllText(Path.Combine(folder, "prompt.txt")));
        Assert.Equal(JobFeeder.Script, File.ReadAllText(Path.Combine(folder, "feed.ps1")));
        var first = File.ReadAllText(Path.Combine(folder, "inbox", JobFeeder.PromptFile));
        Assert.Equal("""{"type":"user","message":{"role":"user","content":"Fix it."},"parent_tool_use_id":null,"uuid":null}""" + "\n", first);
        var meta = JsonNode.Parse(File.ReadAllText(Path.Combine(folder, "meta.json")))!.AsObject();
        Assert.Equal("stream-json", (string?)meta["input"]);
        Assert.True(JobFolder.ReadMeta(folder, id)!.Input);

        var launch = Assert.Single(_host.Launches);
        Assert.True(launch.Input);
        var start = Assert.Single(_host.Started);
        var sep = Path.DirectorySeparatorChar;
        Assert.Equal(
            "/d /v:off /s /c \"\"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -NoProfile -NonInteractive -ExecutionPolicy Bypass"
            + $" -File \"{folder}{sep}feed.ps1\" \"{folder}\" | \"C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd\" -p --input-format stream-json"
            + " --output-format stream-json --verbose --replay-user-messages --permission-mode bypassPermissions"
            + $" > \"{folder}{sep}out.jsonl\" 2> \"{folder}{sep}err.txt\"\"",
            start.CommandLine);
    }

    [Fact]
    public async Task Without_Windows_PowerShell_or_without_input_the_job_runs_as_before()
    {
        _host.PowerShell = null;
        await RunAsync("code_start", new JsonObject { ["project"] = "anemo", ["prompt"] = "Fix it.", ["input"] = true });
        await RunAsync("code_start", new JsonObject { ["project"] = "anemo", ["prompt"] = "Fix it." });

        Assert.All(_host.Launches, l => Assert.False(l.Input));
        Assert.All(_host.Started, s => Assert.Contains("< \"", s.CommandLine));
        Assert.All(Directory.GetDirectories(_jobs.Jobs), f =>
        {
            Assert.False(Directory.Exists(Path.Combine(f, "inbox")));
            Assert.Null(JsonNode.Parse(File.ReadAllText(Path.Combine(f, "meta.json")))!["input"]);
        });
    }

    [Fact]
    public async Task A_message_goes_into_the_inbox_and_send_now_interrupts_first()
    {
        var job = RunningInputJob();

        var queued = await RunAsync("code_input", Fields(job, "Also update the docs."));
        _time.Now = _time.Now.AddSeconds(1);
        var now = await RunAsync("code_input", Fields(job, "Stop, do this first.", "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c", now: true));

        Assert.Equal(new JsonObject { ["job_id"] = job.Id, ["message_id"] = Message, ["state"] = "sent" }.ToJsonString(), queued.State!.ToJsonString());
        Assert.True(now.Ok, now.Error);
        var files = Directory.GetFiles(Path.Combine(job.Folder, "inbox"), "*-m-*.jsonl").Order(StringComparer.Ordinal).ToArray();
        Assert.Equal(2, files.Length);
        Assert.EndsWith($"-m-{Message}.jsonl", files[0]);
        Assert.Equal(
            $$"""{"type":"user","message":{"role":"user","content":"Also update the docs."},"parent_tool_use_id":null,"uuid":"{{Message}}"}""" + "\n",
            File.ReadAllText(files[0]));
        var lines = File.ReadAllLines(files[1]);
        Assert.Equal("""{"type":"control_request","request_id":"interrupt-0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c","request":{"subtype":"interrupt"}}""", lines[0]);
        Assert.Contains("\"Stop, do this first.\"", lines[1]);
        Assert.False(File.Exists(files[0] + ".tmp"));
    }

    [Fact]
    public async Task A_message_s_images_are_listed_after_its_text()
    {
        var job = RunningInputJob();
        var fields = Fields(job, "Like this.");
        fields["images"] = new JsonArray(new JsonObject { ["name"] = "1-shot.png", ["data"] = Convert.ToBase64String(Png()) });

        var outcome = await RunAsync("code_input", fields);

        Assert.True(outcome.Ok, outcome.Error);
        var image = Path.Combine(job.Folder, "messages", Message, "images", "1-shot.png");
        Assert.True(File.Exists(image));
        var file = Assert.Single(Directory.GetFiles(Path.Combine(job.Folder, "inbox"), "*-m-*.jsonl"));
        var content = (string)JsonNode.Parse(File.ReadAllText(file))!["message"]!["content"]!;
        Assert.Equal(CodeJobImages.Prompt("Like this.", [Path.GetFullPath(image)]), content);
    }

    [Fact]
    public async Task A_job_that_takes_no_messages_says_so()
    {
        var plain = _jobs.Add(_time.Now.AddMinutes(-2), pid: 4321, suffix: "pl41");
        _processes.Running[4321] = plain.Started;
        var closed = RunningInputJob(suffix: "cl05", pid: 4322);
        File.WriteAllText(Path.Combine(closed.Folder, "inbox", "closed"), "");

        var a = await RunAsync("code_input", Fields(plain, "Hi"));
        var b = await RunAsync("code_input", Fields(closed, "Hi"));
        var c = await RunAsync("code_input", new JsonObject { ["job_id"] = closed.Id, ["message_id"] = "not-a-uuid", ["prompt"] = "Hi" });

        Assert.Equal("This job doesn't take messages while it runs.", a.Error);
        Assert.Equal(CodeJobControl.NoInputMessage, b.Error);
        Assert.Equal(ResultCodes.Failed, b.Code);
        Assert.False(c.Ok);
        Assert.Empty(Directory.GetFiles(Path.Combine(closed.Folder, "inbox"), "*-m-*"));
    }

    [Fact]
    public async Task A_message_still_in_the_inbox_is_withdrawn_from_it()
    {
        var job = RunningInputJob();
        await RunAsync("code_input", Fields(job, "Also update the docs."));

        var outcome = await RunAsync("code_input_withdraw", new JsonObject { ["job_id"] = job.Id, ["message_id"] = Message });

        Assert.Equal(new JsonObject { ["job_id"] = job.Id, ["message_id"] = Message, ["withdrawn"] = true }.ToJsonString(), outcome.State!.ToJsonString());
        Assert.Empty(Directory.GetFiles(Path.Combine(job.Folder, "inbox"), "*.jsonl").Where(f => !f.EndsWith(JobFeeder.PromptFile)));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task A_forwarded_message_is_withdrawn_by_asking_Claude_Code(bool cancelled)
    {
        var job = RunningInputJob();
        var inbox = Path.Combine(job.Folder, "inbox");
        File.WriteAllText(Path.Combine(inbox, $"00000000000000000001-m-{Message}.sent"), "");
        // Claude Code answers the control request the feeder forwards.
        var answer = Task.Run(async () =>
        {
            for (var i = 0; i < 100 && !Directory.GetFiles(inbox, "*-w-*.jsonl").Any(); i++)
            {
                await Task.Delay(20);
            }

            var answered = cancelled ? "true" : "false";
            job.Write("{\"type\":\"control_response\",\"response\":{\"subtype\":\"success\",\"request_id\":\"withdraw-" + Message
                + "\",\"response\":{\"cancelled\":" + answered + ",\"message_uuid\":\"" + Message + "\"}}}");
        });

        var outcome = await RunAsync("code_input_withdraw", new JsonObject { ["job_id"] = job.Id, ["message_id"] = Message });
        await answer;

        Assert.Equal(cancelled, (bool)outcome.State!["withdrawn"]!);
        var request = File.ReadAllText(Assert.Single(Directory.GetFiles(inbox, "*-w-*.jsonl")));
        Assert.Contains("\"subtype\":\"cancel_async_message\"", request);
        Assert.Contains($"\"message_uuid\":\"{Message}\"", request);
    }

    [Fact]
    public async Task Nothing_is_withdrawn_from_a_job_that_stopped_taking_messages()
    {
        var job = RunningInputJob();
        File.WriteAllText(Path.Combine(job.Folder, "inbox", "closed"), "");

        var outcome = await RunAsync("code_input_withdraw", new JsonObject { ["job_id"] = job.Id, ["message_id"] = Message });

        Assert.False((bool)outcome.State!["withdrawn"]!);
    }

    [Fact]
    public void The_answer_to_a_withdrawal_is_read_from_the_control_response()
    {
        const string request = "withdraw-x";
        Assert.True(CodeJobControl.WithdrawAnswer("""{"type":"control_response","response":{"request_id":"withdraw-x","response":{"cancelled":true}}}""", request));
        Assert.False(CodeJobControl.WithdrawAnswer("""{"type":"control_response","response":{"subtype":"error","request_id":"withdraw-x","error":"unknown"}}""", request));
        Assert.Null(CodeJobControl.WithdrawAnswer("""{"type":"control_response","response":{"request_id":"other","response":{"cancelled":true}}}""", request));
        Assert.Null(CodeJobControl.WithdrawAnswer("not json withdraw-x", request));
    }

    [Fact]
    public void A_job_that_takes_messages_runs_while_its_process_lives_whatever_its_results_say()
    {
        var job = RunningInputJob();
        job.Finish(error: true); // an interrupted answer
        var meta = JobFolder.ReadMeta(job.Folder, job.Id)!;

        Assert.Equal(JobStates.Running, JobState.Read(job.Folder, meta, _processes, _time.Now));
        _processes.Running.Clear();
        job.Finish(); // its last answer
        Assert.Equal(JobStates.Done, JobState.Read(job.Folder, meta, _processes, _time.Now));
    }

    [Fact]
    public void Code_job_says_whether_the_job_takes_messages_and_the_offer_whether_jobs_can()
    {
        var snapshot = new JobSnapshot("20261122-100000-k3x9", "C:\\jobs\\x", "anemo", "C:\\dev\\anemo", _time.Now, "p", null, null, 1, "running", null, null, null, Input: true);
        Assert.Contains("\"input\":true", CodeWire.Job(snapshot));
        Assert.Contains("\"input\":false", CodeWire.Job(snapshot with { Input = false }));
        Assert.EndsWith("\"code_input\":true}", Wire.Offer(true, true, true, true, codeInput: true));
        Assert.EndsWith("\"code_input\":false}", Wire.Offer(true, true, true, false, codeInput: true));
    }

    // -- helpers -------------------------------------------------------------------------

    private FakeJob RunningInputJob(string suffix = "in42", int pid = 4321)
    {
        var job = _jobs.Add(_time.Now.AddMinutes(-2), pid: pid, suffix: suffix);
        var meta = JsonNode.Parse(File.ReadAllText(Path.Combine(job.Folder, "meta.json")))!.AsObject();
        meta["input"] = "stream-json";
        File.WriteAllText(Path.Combine(job.Folder, "meta.json"), meta.ToJsonString());
        Directory.CreateDirectory(Path.Combine(job.Folder, "inbox"));
        File.WriteAllText(Path.Combine(job.Folder, "inbox", "00000000000000000000-prompt.sent"), "");
        _processes.Running[pid] = job.Started;
        return job;
    }

    private static JsonObject Fields(FakeJob job, string prompt, string message = Message, bool now = false) => new()
    {
        ["job_id"] = job.Id,
        ["message_id"] = message,
        ["prompt"] = prompt,
        ["now"] = now,
    };

    private static byte[] Png() => [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0];

    private Task<CommandOutcome> RunAsync(string action, JsonObject fields)
    {
        var command = new JsonObject { ["type"] = "device.command", ["id"] = Guid.NewGuid().ToString(), ["action"] = action };
        foreach (var (key, value) in fields)
        {
            command[key] = value?.DeepClone();
        }

        return _processor.ExecuteAsync(command, Trusted, CancellationToken.None);
    }
}
