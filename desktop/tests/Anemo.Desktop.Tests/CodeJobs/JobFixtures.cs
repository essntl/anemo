using System.Collections.Concurrent;
using System.Text;
using System.Text.Json.Nodes;
using Anemo.Desktop.Core.CodeJobs;

namespace Anemo.Desktop.Tests.CodeJobs;

/// <summary>A temporary jobs folder in <c>cc.ps1</c>'s format, with realistic jobs.</summary>
public sealed class JobsFolder : IDisposable
{
    public JobsFolder()
    {
        Root = Path.Combine(Path.GetTempPath(), "anemo-code-jobs-tests", Guid.NewGuid().ToString("N"));
        Jobs = Path.Combine(Root, "jobs");
        Directory.CreateDirectory(Jobs);
    }

    /// <summary>Holds <c>jobs/</c>, <c>repos/</c> and the state file.</summary>
    public string Root { get; }

    public string Jobs { get; }

    public string StateFile => Path.Combine(Root, "code-jobs.json");

    /// <summary>A job folder with <c>meta.json</c> and <c>prompt.txt</c>; its out.jsonl starts empty.</summary>
    public FakeJob Add(DateTimeOffset started, int? pid = 4242, string suffix = "ab12", string project = "anemo", string prompt = "Fix the flaky test.\nThen open a PR.", string? resume = null, string? model = null)
    {
        var id = $"{started:yyyyMMdd-HHmmss}-{suffix}";
        var folder = Path.Combine(Jobs, id);
        Directory.CreateDirectory(folder);
        var dir = Path.Combine(Root, "repos", project);
        Directory.CreateDirectory(dir);
        var meta = new JsonObject
        {
            ["id"] = id,
            ["pid"] = pid,
            ["dir"] = dir,
            ["resume"] = resume,
            ["started"] = started.ToString("yyyy-MM-ddTHH:mm:ss.fffffffzzz"),
            ["prompt_preview"] = prompt.Length > 80 ? prompt[..80] : prompt,
            ["unknown_field"] = "ignored",
        };
        if (model is not null)
        {
            meta["model"] = model;
        }

        File.WriteAllText(Path.Combine(folder, "meta.json"), meta.ToJsonString());
        File.WriteAllText(Path.Combine(folder, "prompt.txt"), prompt);
        File.WriteAllText(Path.Combine(folder, "out.jsonl"), "");
        File.WriteAllText(Path.Combine(folder, "err.txt"), "");
        return new FakeJob(id, folder, dir, started);
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(Root, true);
        }
        catch (IOException)
        {
        }
    }
}

public sealed record FakeJob(string Id, string Folder, string Dir, DateTimeOffset Started)
{
    public string OutPath => Path.Combine(Folder, "out.jsonl");

    public void Write(params string[] lines) =>
        File.AppendAllText(OutPath, string.Concat(lines.Select(l => l + "\n")), new UTF8Encoding(false));

    public void WriteRaw(string text) => File.AppendAllText(OutPath, text, new UTF8Encoding(false));

    /// <summary>A typical run: init, text, a Bash call and its result.</summary>
    public void WriteTurn(int count = 1)
    {
        Write(CodeEvents.Init("sess-1"));
        for (var i = 0; i < count; i++)
        {
            Write(CodeEvents.Text($"Looking at step {i}."), CodeEvents.Bash($"toolu_{i}", "git status"), CodeEvents.BashResult($"toolu_{i}", "On branch main"));
        }
    }

    public void Finish(bool error = false, string subtype = "success") => Write(CodeEvents.Result(error, subtype));

    public void Cancel() => File.WriteAllText(Path.Combine(Folder, "cancelled"), "");

    public void Stderr(string text) => File.WriteAllText(Path.Combine(Folder, "err.txt"), text);

    public void Branch(string branch)
    {
        Directory.CreateDirectory(Path.Combine(Dir, ".git"));
        File.WriteAllText(Path.Combine(Dir, ".git", "HEAD"), $"ref: refs/heads/{branch}\n");
    }
}

/// <summary>Lines as Claude Code's <c>--output-format stream-json --verbose</c> writes them.</summary>
public static class CodeEvents
{
    public static string Init(string session) =>
        $$"""{"type":"system","subtype":"init","cwd":"C:\\dev\\anemo","session_id":"{{session}}","tools":["Bash","Read","Edit"],"model":"claude-opus-4-1","permissionMode":"bypassPermissions"}""";

    public static string Text(string text) => new JsonObject
    {
        ["type"] = "assistant",
        ["message"] = new JsonObject
        {
            ["id"] = "msg_1",
            ["role"] = "assistant",
            ["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = text }),
        },
        ["parent_tool_use_id"] = null,
        ["session_id"] = "sess-1",
    }.ToJsonString();

    public static string Bash(string id, string command) => new JsonObject
    {
        ["type"] = "assistant",
        ["message"] = new JsonObject
        {
            ["content"] = new JsonArray(new JsonObject
            {
                ["type"] = "tool_use",
                ["id"] = id,
                ["name"] = "Bash",
                ["input"] = new JsonObject { ["command"] = command, ["description"] = "Run it" },
            }),
        },
        ["parent_tool_use_id"] = null,
        ["session_id"] = "sess-1",
    }.ToJsonString();

    public static string BashResult(string id, string stdout) => new JsonObject
    {
        ["type"] = "user",
        ["message"] = new JsonObject
        {
            ["role"] = "user",
            ["content"] = new JsonArray(new JsonObject { ["type"] = "tool_result", ["tool_use_id"] = id, ["content"] = stdout, ["is_error"] = false }),
        },
        ["parent_tool_use_id"] = null,
        ["session_id"] = "sess-1",
        ["tool_use_result"] = new JsonObject { ["stdout"] = stdout, ["stderr"] = "", ["interrupted"] = false },
    }.ToJsonString();

    /// <summary>A Read result: the file's text is in the tool result and again in <c>tool_use_result.file.content</c>.</summary>
    public static string ReadResult(string id, string content) => new JsonObject
    {
        ["type"] = "user",
        ["message"] = new JsonObject
        {
            ["content"] = new JsonArray(new JsonObject { ["type"] = "tool_result", ["tool_use_id"] = id, ["content"] = content }),
        },
        ["tool_use_result"] = new JsonObject
        {
            ["type"] = "text",
            ["file"] = new JsonObject { ["filePath"] = "C:\\dev\\anemo\\README.md", ["content"] = content, ["numLines"] = 3 },
        },
    }.ToJsonString();

    public static string Result(bool error = false, string subtype = "success") => new JsonObject
    {
        ["type"] = "result",
        ["subtype"] = subtype,
        ["is_error"] = error,
        ["duration_ms"] = 81234,
        ["num_turns"] = 12,
        ["result"] = "Fixed the test and opened https://github.com/essntl/anemo/pull/70",
        ["session_id"] = "sess-1",
        ["total_cost_usd"] = 0.4321,
    }.ToJsonString();

    /// <summary>An event of about <paramref name="bytes"/> bytes (strings under 2000 characters, so trimming leaves it).</summary>
    public static string Sized(int bytes)
    {
        var parts = new JsonArray();
        for (var left = bytes; left > 0; left -= 1500)
        {
            parts.Add(new string('x', Math.Min(1500, left)));
        }

        return new JsonObject { ["type"] = "assistant", ["parts"] = parts }.ToJsonString();
    }
}

/// <summary>A process probe the tests set by hand: pid → start time (null: unknown).</summary>
public sealed class FakeProcesses : IProcessProbe
{
    public ConcurrentDictionary<int, DateTimeOffset?> Running { get; } = new();

    public ProcessFacts? Find(int pid) => Running.TryGetValue(pid, out var at) ? new ProcessFacts(at) : null;
}

