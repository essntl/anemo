using System.Text;
using Anemo.Desktop.Core.CodeJobs;

namespace Anemo.Desktop.Tests.CodeJobs;

/// <summary>meta.json, prompt.txt, err.txt, the branch and the process check.</summary>
public sealed class JobFolderTests : IDisposable
{
    private readonly JobsFolder _jobs = new();
    private readonly string _folder;

    public JobFolderTests()
    {
        _folder = Path.Combine(_jobs.Jobs, "20261122-093000-ab12");
        Directory.CreateDirectory(_folder);
    }

    public void Dispose() => _jobs.Dispose();

    [Theory]
    [InlineData("20261122-093000-ab12", true)]
    [InlineData("20261122-093000-AB9z", true)]
    [InlineData("20261122-093000-ab1", false)]
    [InlineData("20261122-093000-ab12x", false)]
    [InlineData("2026112-093000-ab12", false)]
    [InlineData("20261399-093000-ab12", false)]
    [InlineData("..", false)]
    public void Job_ids_match_the_pattern(string id, bool valid) => Assert.Equal(valid, JobFolder.IsJobId(id));

    [Fact]
    public void Meta_is_read_with_unknown_fields_ignored()
    {
        Write("meta.json", """
            {"id":"20261122-093000-ab12","pid":4242,"dir":"C:\\dev\\anemo","resume":"sess-0","started":"2026-11-22T09:30:00.1234567+01:00",
             "prompt_preview":"Fix the…","model":"opus","extra":{"x":1}}
            """);

        var meta = JobFolder.ReadMeta(_folder, "20261122-093000-ab12")!;

        Assert.Equal(4242, meta.Pid);
        Assert.Equal(@"C:\dev\anemo", meta.Dir);
        Assert.Equal("sess-0", meta.ResumeSession);
        Assert.Equal(new DateTimeOffset(2026, 11, 22, 9, 30, 0, TimeSpan.FromHours(1)).AddTicks(1234567), meta.Started);
        Assert.Equal("opus", meta.Model);
        Assert.Equal("Fix the…", meta.PromptPreview);
    }

    [Fact]
    public void Meta_written_by_Windows_PowerShell_reads_too()
    {
        // UTF-16 with a BOM (Out-File), a /Date()/ time (ConvertTo-Json of a DateTime), the pid as text, an empty resume.
        File.WriteAllText(Path.Combine(_folder, "meta.json"),
            """{"id":"20261122-093000-ab12","pid":"77","dir":"C:\\dev\\x","resume":"","started":"\/Date(1795339800000)\/"}""",
            Encoding.Unicode);

        var meta = JobFolder.ReadMeta(_folder, "20261122-093000-ab12")!;

        Assert.Equal(77, meta.Pid);
        Assert.Null(meta.ResumeSession);
        Assert.Equal(DateTimeOffset.FromUnixTimeMilliseconds(1795339800000), meta.Started);
        Assert.Null(meta.Model);
    }

    [Fact]
    public void Meta_without_a_start_time_takes_the_id_s_time()
    {
        Write("meta.json", """{"pid":null,"dir":"C:\\dev\\x"}""");

        var meta = JobFolder.ReadMeta(_folder, "20261122-093000-ab12")!;

        Assert.Null(meta.Pid);
        Assert.Equal(new DateTime(2026, 11, 22, 9, 30, 0), meta.Started.DateTime);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("{\"pid\":")]
    [InlineData("[1,2]")]
    public void Meta_that_is_missing_or_half_written_does_not_read(string? text)
    {
        if (text is not null)
        {
            Write("meta.json", text);
        }

        Assert.Null(JobFolder.ReadMeta(_folder, "20261122-093000-ab12"));
    }

    [Fact]
    public void The_prompt_is_prompt_txt_else_the_preview()
    {
        var meta = new JobMeta(1, "", null, DateTimeOffset.UtcNow, "the preview", null);
        Assert.Equal("the preview", JobFolder.ReadPrompt(_folder, meta));

        File.WriteAllText(Path.Combine(_folder, "prompt.txt"), "Fix it.\nGrüße", new UTF8Encoding(true));
        Assert.Equal("Fix it.\nGrüße", JobFolder.ReadPrompt(_folder, meta));
    }

    [Fact]
    public void The_stderr_tail_is_the_last_4000_characters()
    {
        Assert.Null(JobFolder.StderrTail(_folder));
        Write("err.txt", "");
        Assert.Null(JobFolder.StderrTail(_folder));

        Write("err.txt", new string('a', 10_000) + "Error: the end");
        var tail = JobFolder.StderrTail(_folder)!;

        Assert.Equal(4000, tail.Length);
        Assert.EndsWith("Error: the end", tail);
    }

    [Fact]
    public void The_stderr_tail_never_starts_with_half_a_character()
    {
        Write("err.txt", string.Concat(Enumerable.Repeat("ж😀", 5000)));

        var tail = JobFolder.StderrTail(_folder)!;

        Assert.True(tail.Length <= 4000);
        Assert.False(char.IsLowSurrogate(tail[0]));
        Assert.DoesNotContain('\uFFFD', tail);
    }

    [Theory]
    [InlineData("utf-16")]
    [InlineData("utf-16BE")]
    [InlineData("utf-8-bom")]
    public void A_large_stderr_with_a_byte_order_mark_is_read_in_its_encoding(string name)
    {
        // Windows PowerShell writes UTF-16 with a BOM; the tail is read from far past the BOM.
        var encoding = name switch
        {
            "utf-16" => new UnicodeEncoding(bigEndian: false, byteOrderMark: true),
            "utf-16BE" => new UnicodeEncoding(bigEndian: true, byteOrderMark: true),
            _ => (Encoding)new UTF8Encoding(true),
        };
        File.WriteAllText(Path.Combine(_folder, "err.txt"), string.Concat(Enumerable.Repeat("Gr\u00FC\u00DFe \u0436 \uD83D\uDE00 ", 3000)) + "Error: the end", encoding);
        Assert.True(new FileInfo(Path.Combine(_folder, "err.txt")).Length > 16_000);

        var tail = JobFolder.StderrTail(_folder)!;

        Assert.EndsWith("\uD83D\uDE00 Error: the end", tail);
        Assert.True(tail.Length <= 4000 && tail.Length > 3900);
        Assert.DoesNotContain('\0', tail);
        Assert.DoesNotContain('\uFFFD', tail);
        Assert.False(char.IsLowSurrogate(tail[0]));
        Assert.Contains("Gr\u00FC\u00DFe \u0436", tail);
    }

    [Fact]
    public void A_small_UTF_16_stderr_is_read_whole()
    {
        File.WriteAllText(Path.Combine(_folder, "err.txt"), "Fehler: Gr\u00FC\u00DFe", Encoding.Unicode);

        Assert.Equal("Fehler: Gr\u00FC\u00DFe", JobFolder.StderrTail(_folder));
    }

    [Fact]
    public void Code_job_strings_have_no_NUL_characters()
    {
        const string nul = "a\0b";
        var job = new JobSnapshot(
            "20261122-093000-ab12", "C:\\jobs\0x", "pro\0ject", "C:\\dev\\pro\0ject", DateTimeOffset.UtcNow,
            "prompt " + nul, "sess" + nul, "op\0us", 1, JobStates.Failed, DateTimeOffset.UtcNow, "feat/\0x", "err " + nul);

        var text = CodeWire.Job(job);

        Assert.DoesNotContain("\\u0000", text);
        var sent = System.Text.Json.Nodes.JsonNode.Parse(text)!["job"]!.AsObject();
        foreach (var key in new[] { "device_job_dir", "project", "dir", "prompt", "resume_session", "model", "branch", "stderr_tail" })
        {
            var value = (string?)sent[key];
            Assert.DoesNotContain('\0', value!);
            Assert.Contains('\uFFFD', value!);
        }

        Assert.Equal("prompt a\uFFFDb", (string?)sent["prompt"]);
    }

    [Fact]
    public void The_branch_comes_from_git_HEAD()
    {
        var dir = Path.Combine(_jobs.Root, "repo");
        Directory.CreateDirectory(Path.Combine(dir, ".git"));
        File.WriteAllText(Path.Combine(dir, ".git", "HEAD"), "ref: refs/heads/feat/code-sessions\n");

        Assert.Equal("feat/code-sessions", JobFolder.Branch(dir));

        File.WriteAllText(Path.Combine(dir, ".git", "HEAD"), "84fdf19a2b3c4d5e6f708192a3b4c5d6e7f80912\n");
        Assert.Null(JobFolder.Branch(dir)); // detached
    }

    [Fact]
    public void A_worktree_s_git_file_points_to_its_HEAD()
    {
        var main = Path.Combine(_jobs.Root, "main");
        var gitDir = Path.Combine(main, ".git", "worktrees", "wt1");
        Directory.CreateDirectory(gitDir);
        File.WriteAllText(Path.Combine(gitDir, "HEAD"), "ref: refs/heads/fix/flaky\n");
        var worktree = Path.Combine(_jobs.Root, "wt1");
        Directory.CreateDirectory(worktree);

        File.WriteAllText(Path.Combine(worktree, ".git"), $"gitdir: {gitDir}\n");
        Assert.Equal("fix/flaky", JobFolder.Branch(worktree));

        File.WriteAllText(Path.Combine(worktree, ".git"), $"gitdir: {Path.Combine("..", "main", ".git", "worktrees", "wt1")}\n");
        Assert.Equal("fix/flaky", JobFolder.Branch(worktree));
    }

    [Fact]
    public void No_repository_no_branch()
    {
        Assert.Null(JobFolder.Branch(_folder));
        Assert.Null(JobFolder.Branch(""));
        Assert.Null(JobFolder.Branch(Path.Combine(_jobs.Root, "missing")));
    }

    [Theory]
    [InlineData(@"C:\dev\anemo", "anemo")]
    [InlineData(@"C:\dev\anemo\", "anemo")]
    [InlineData("/home/a/anemo", "anemo")]
    [InlineData("anemo", "anemo")]
    [InlineData("", "")]
    public void The_project_is_the_last_segment_of_the_folder(string dir, string project) =>
        Assert.Equal(project, JobFolder.Project(dir));

    [Fact]
    public void A_process_is_the_job_s_while_it_started_within_a_minute_of_the_job()
    {
        var started = new DateTimeOffset(2026, 11, 22, 9, 30, 0, TimeSpan.Zero);
        var processes = new FakeProcesses();

        Assert.False(ProcessLiveness.IsAlive(processes, 4242, started)); // gone
        Assert.False(ProcessLiveness.IsAlive(processes, null, started)); // no pid

        processes.Running[4242] = started.AddSeconds(-2);
        Assert.True(ProcessLiveness.IsAlive(processes, 4242, started));

        processes.Running[4242] = started.AddSeconds(59);
        Assert.True(ProcessLiveness.IsAlive(processes, 4242, started));

        processes.Running[4242] = started.AddMinutes(5); // the pid was given to another program
        Assert.False(ProcessLiveness.IsAlive(processes, 4242, started));

        processes.Running[4242] = null; // can't tell: counts as alive
        Assert.True(ProcessLiveness.IsAlive(processes, 4242, started));
    }

    private void Write(string name, string text) => File.WriteAllText(Path.Combine(_folder, name), text, new UTF8Encoding(false));
}
