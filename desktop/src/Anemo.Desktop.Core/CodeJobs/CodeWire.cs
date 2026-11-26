using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using Anemo.Desktop.Core.Protocol;

namespace Anemo.Desktop.Core.CodeJobs;

/// <summary>The five states of a job (device-contracts.md §7.2).</summary>
public static class JobStates
{
    public const string Running = "running";
    public const string Done = "done";
    public const string Failed = "failed";
    public const string Cancelled = "cancelled";
    public const string ExitedWithoutResult = "exited_without_result";

    public static bool IsTerminal(string? state) => state is Done or Failed or Cancelled or ExitedWithoutResult;
}

/// <summary>What a <c>code.job</c> says about a job.</summary>
public sealed record JobSnapshot(
    string Id,
    string JobDir,
    string Project,
    string Dir,
    DateTimeOffset Started,
    string Prompt,
    string? ResumeSession,
    string? Model,
    int? Pid,
    string State,
    DateTimeOffset? Ended,
    string? Branch,
    string? StderrTail,
    bool Input = false); // it takes messages now (§15): running, and its feeder hasn't closed its stdin

/// <summary>One item of a <c>code.events</c> frame, already serialized.</summary>
public sealed record EventItem(long Seq, string Json, long EndOffset);

/// <summary>The <c>code.*</c> messages of device-contracts.md §7.1.</summary>
public static class CodeWire
{
    private const string TimeFormat = "yyyy-MM-dd'T'HH:mm:ss.fffzzz";

    /// <summary>
    /// A <c>code.job</c>, shortened (stderr tail first, then the prompt) to fit 64 000
    /// characters. Every string has its NUL characters replaced by U+FFFD (Postgres stores none).
    /// </summary>
    public static string Job(JobSnapshot job)
    {
        var prompt = Text(job.Prompt, CodeJobLimits.MaxPromptChars)!;
        var stderr = job.StderrTail is null ? null : JobFolder.Tail(Clean(job.StderrTail), CodeJobLimits.MaxStderrChars);
        while (true)
        {
            var text = Wire.Json(new JsonObject
            {
                ["type"] = "code.job",
                ["job"] = new JsonObject
                {
                    ["id"] = job.Id,
                    ["device_job_dir"] = Text(job.JobDir, CodeJobLimits.MaxPathChars),
                    ["project"] = Text(job.Project, CodeJobLimits.MaxProjectChars),
                    ["dir"] = Text(job.Dir, CodeJobLimits.MaxPathChars),
                    ["started"] = Time(job.Started),
                    ["prompt"] = prompt,
                    ["resume_session"] = Text(job.ResumeSession, CodeJobLimits.MaxSessionChars),
                    ["model"] = Text(job.Model, CodeJobLimits.MaxModelChars),
                    ["pid"] = job.Pid,
                    ["state"] = job.State,
                    ["ended"] = job.Ended is { } ended ? Time(ended) : null,
                    ["branch"] = Text(job.Branch, CodeJobLimits.MaxBranchChars),
                    ["stderr_tail"] = stderr,
                    ["input"] = job.Input,
                },
            });
            if (text.Length <= CodeJobLimits.MaxJobMessageChars || (prompt.Length == 0 && string.IsNullOrEmpty(stderr)))
            {
                return text;
            }

            // Escaped control characters can make a short text long on the wire.
            if (stderr is { Length: > 0 })
            {
                stderr = stderr.Length < 100 ? null : JobFolder.Tail(stderr, stderr.Length / 2);
            }
            else
            {
                prompt = JobFolder.Cut(prompt, prompt.Length / 2);
            }
        }
    }

    public static EventItem Item(long seq, PreparedEvent ev, long endOffset) => new(
        seq,
        Wire.Json(new JsonObject { ["seq"] = seq, ["event"] = ev.Event, ["trimmed"] = ev.Trimmed }),
        endOffset);

    /// <summary>The bytes a <c>code.events</c> frame takes without its items.</summary>
    public static int FrameOverhead(string jobId) => Encoding.UTF8.GetByteCount(Events(jobId, []));

    public static string Events(string jobId, IReadOnlyList<EventItem> items)
    {
        var text = new StringBuilder();
        text.Append("{\"type\":\"code.events\",\"job_id\":").Append(Wire.Json(JsonValue.Create(jobId))).Append(",\"events\":[");
        for (var i = 0; i < items.Count; i++)
        {
            if (i > 0)
            {
                text.Append(',');
            }

            text.Append(items[i].Json);
        }

        return text.Append("]}").ToString();
    }

    /// <summary>A <c>code.ack</c>: its job id and seq, or null when it is malformed.</summary>
    public static (string JobId, long Seq)? Ack(JsonObject msg)
    {
        if (Wire.Str(msg, "job_id") is not { Length: > 0 } id || Wire.Number(msg["seq"]) is not { } seq)
        {
            return null;
        }

        return seq >= 0 && seq == Math.Floor(seq) && seq <= long.MaxValue / 2 ? (id, (long)seq) : null;
    }

    private static string Time(DateTimeOffset t) => t.ToString(TimeFormat, CultureInfo.InvariantCulture);

    /// <summary>NUL characters replaced by U+FFFD (the same length, so cuts stay where they were).</summary>
    internal static string Clean(string text) => text.Contains('\0') ? text.Replace('\0', '�') : text;

    private static string? Text(string? text, int max) => text is null ? null : JobFolder.Cut(Clean(text), max);
}
