using System.Text.Json.Nodes;
using Anemo.Desktop.Core.Protocol;

namespace Anemo.Desktop.Core.Commands;

/// <summary>
/// The one-line summary of a command for the local log. It never holds typed text,
/// clipboard text, a PowerShell command or a Claude Code prompt (only their length), nor a
/// URL's path or query.
/// </summary>
public static class CommandSummary
{
    /// <param name="state">The answer, when there is one: <c>code_start</c> logs the new job's id.</param>
    public static string For(JsonObject command, JsonNode? state = null)
    {
        var action = Wire.Str(command, "action") ?? "";
        string? Str(string key) => Wire.Str(command, key);
        int Length(string key) => Str(key)?.Length ?? 0;
        string Target() => Str("ref") is { } r ? $"control {Short(r)}" : $"at {Num("x")}, {Num("y")}";
        string GitTarget() => Str("repo") is { } repo ? $"repository {Short(repo)}" : $"project {Short(Str("project"))}";
        string Num(string key) => Wire.Number(command[key]) is { } d ? d.ToString("0.#", System.Globalization.CultureInfo.InvariantCulture) : "?";

        return action switch
        {
            "look" => Str("window_ref") is { } w ? $"{Short(Str("what"))} {Short(w)}" : Short(Str("what")),
            "click" or "double_click" or "right_click" => Target(),
            "type" => $"{Length("text")} characters " + (Str("ref") is { } r ? $"into control {Short(r)}" : "where the focus is"),
            "press" => command["keys"] is JsonArray keys ? string.Join(" ", keys.Select(KeyForLog)) : "",
            "scroll" => $"{Short(Str("direction"))} {Num("amount")}" + (Str("ref") is { } sr ? $" in control {Short(sr)}" : ""),
            "focus_window" => $"window {Short(Str("window_ref"))}",
            "open" => OpenTarget(Str("target")),
            "clipboard_set" => $"{Length("text")} characters",
            "shell" => $"a command of {Length("command")} characters, timeout {Num("timeout_s")} s",
            "code_projects" => "",
            "code_start" => (state is JsonObject s && Wire.Str(s, "job_id") is { } job ? $"job {Short(job)}, " : "")
                + (Str("follow_job_id") is { } follow ? $"a follow-up of job {Short(follow)}" : $"project {Short(Str("project"))}")
                + $", a prompt of {Length("prompt")} characters",
            "code_cancel" => $"job {Short(Str("job_id"))}",
            "code_git_graph" => GitTarget() + (command["fetch"] is JsonValue f && f.TryGetValue<bool>(out var fetch) && fetch ? ", fetch" : ""),
            "code_git_commit" => $"{GitTarget()}, commit {Short(Str("hash"))}",
            "code_git_cache_clear" => "",
            "file_stat" or "file_read" or "file_write_begin" => Short(Str("path"), 200)
                + (action == "file_read" ? $", {Num("length")} bytes at {Num("offset")}" : "")
                + (action == "file_write_begin" ? $", {Num("size")} bytes" + (command["overwrite"] is JsonValue o && o.TryGetValue<bool>(out var ow) && ow ? ", overwrite" : "") : ""),
            "file_write_chunk" => $"transfer {Short(Str("transfer"), 12)}, {Length("data") / 4 * 3} bytes at {Num("offset")}",
            "file_write_end" or "file_write_abort" => $"transfer {Short(Str("transfer"), 12)}",
            _ => "unknown action",
        };
    }

    /// <summary>The action name as logged (cut short when the server sent something odd).</summary>
    public static string Action(JsonObject command) => Short(Wire.Str(command, "action")) is { Length: > 0 } a ? a : "?";

    /// <summary>A plain letter or digit could spell out typed text, so it is logged as •.</summary>
    private static string KeyForLog(JsonNode? key)
    {
        var s = key is JsonValue v && v.TryGetValue<string>(out var k) ? k : "?";
        return s.Length == 1 ? "•" : Short(s, 30);
    }

    private static string OpenTarget(string? target)
    {
        if (target is null)
        {
            return "";
        }

        if (Uri.TryCreate(target.Trim(), UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https")
        {
            return $"{uri.Scheme}://{uri.Host}";
        }

        return Short(target, 80);
    }

    private static string Short(string? s, int max = 40) =>
        s is null ? "" : s.Length <= max ? s : s[..max] + "…";
}
