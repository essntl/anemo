using System.Text.Json;
using System.Text.Json.Nodes;

namespace Anemo.Desktop.Core.CodeJobs;

/// <summary>A job's state from its folder and its process (device-contracts.md §7.2).</summary>
public static class JobState
{
    /// <summary>
    /// Null when the line isn't a <c>result</c> event; else whether it failed (<c>is_error</c>,
    /// or a <c>subtype</c> other than <c>success</c>).
    /// </summary>
    public static bool? ResultOf(string line)
    {
        if (!line.Contains("\"result\"", StringComparison.Ordinal))
        {
            return null; // the quick test: most lines aren't parsed at all
        }

        try
        {
            if (JsonNode.Parse(line) is JsonObject ev && Protocol.Wire.Str(ev, "type") == "result")
            {
                var isError = ev["is_error"] is JsonValue e && e.GetValueKind() == JsonValueKind.True;
                return isError || Protocol.Wire.Str(ev, "subtype") != "success";
            }
        }
        catch (Exception e) when (e is JsonException or ArgumentException or InvalidOperationException)
        {
            // A raw line: not a result.
        }

        return null;
    }

    /// <summary>
    /// The job counts as running: its process lives (<see cref="ProcessLiveness"/>), or Anemo
    /// Desktop is still cloning or making its project (a <c>starting</c> file, no pid yet), for
    /// at most 15 minutes after the job was made (§12.5).
    /// </summary>
    public static bool IsAlive(string folder, JobMeta meta, IProcessProbe probe, DateTimeOffset now)
    {
        if (meta.Pid is null)
        {
            return File.Exists(Path.Combine(folder, JobFolder.Starting)) && now - meta.Started <= CodeJobLimits.StartingFor;
        }

        return ProcessLiveness.IsAlive(probe, meta.Pid, meta.Started, JobFolder.LastOutputAt(folder), now);
    }

    /// <summary>The state now, reading the whole <c>out.jsonl</c> (for one look, not for a loop).</summary>
    public static string Read(string folder, JobMeta meta, IProcessProbe probe, DateTimeOffset now)
    {
        if (JobFolder.IsCancelled(folder))
        {
            return JobStates.Cancelled;
        }

        var alive = IsAlive(folder, meta, probe, now);
        bool? failed = null;
        JsonlTail.Each(Path.Combine(folder, JobFolder.Out), LinePosition.Start, line =>
        {
            if (ResultOf(line.Text) is { } f)
            {
                failed = f;
            }
        });

        return failed is { } fail ? (fail ? JobStates.Failed : JobStates.Done)
            : alive ? JobStates.Running
            : JobStates.ExitedWithoutResult;
    }
}
