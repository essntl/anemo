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

    /// <summary>The state now, reading the whole <c>out.jsonl</c> (for one look, not for a loop).</summary>
    public static string Read(string folder, JobMeta meta, IProcessProbe probe, DateTimeOffset now)
    {
        if (JobFolder.IsCancelled(folder))
        {
            return JobStates.Cancelled;
        }

        var alive = ProcessLiveness.IsAlive(probe, meta.Pid, meta.Started, JobFolder.LastOutputAt(folder), now);
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
