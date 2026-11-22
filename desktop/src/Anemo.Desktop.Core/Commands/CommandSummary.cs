using System.Text.Json.Nodes;
using Anemo.Desktop.Core.Protocol;

namespace Anemo.Desktop.Core.Commands;

/// <summary>
/// The one-line summary of a command for the local log. It never holds typed text,
/// clipboard text or a PowerShell command (only their length), nor a URL's path or query.
/// </summary>
public static class CommandSummary
{
    public static string For(JsonObject command)
    {
        var action = Wire.Str(command, "action") ?? "";
        string? Str(string key) => Wire.Str(command, key);
        int Length(string key) => Str(key)?.Length ?? 0;
        string Target() => Str("ref") is { } r ? $"control {Short(r)}" : $"at {Num("x")}, {Num("y")}";
        string Num(string key) => command[key] is JsonValue v && v.TryGetValue<double>(out var d) ? d.ToString("0.#") : "?";

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
