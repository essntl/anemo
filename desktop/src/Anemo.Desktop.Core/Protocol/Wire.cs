using System.Text.Json;
using System.Text.Json.Nodes;

namespace Anemo.Desktop.Core.Protocol;

/// <summary>The device as the server describes it in <c>welcome</c>.</summary>
public sealed record DeviceInfo(string Id, string Name, string Kind, string Trust)
{
    public bool Trusted => Trust == "trusted";
}

/// <summary>The outcome of one command, before it becomes a <c>device.result</c>.</summary>
public sealed record CommandOutcome(bool Ok, JsonNode? State, string? Code, string? Error)
{
    public static CommandOutcome Success(JsonNode state) => new(true, state, null, null);

    public static CommandOutcome Fail(string code, string error) => new(false, null, code, error);
}

/// <summary>The JSON messages of device-contracts.md §2, both ways.</summary>
public static class Wire
{
    public const int MaxErrorLength = 500;

    /// <summary>The largest result the server takes (12 MB); a larger one is answered as failed.</summary>
    public const int MaxResultBytes = 12 * 1024 * 1024;

    public const string TooLargeMessage = "The answer was too large";

    /// <summary>Plain JSON: base64 and non-ASCII text are not turned into escapes.</summary>
    private static readonly JsonSerializerOptions Relaxed = new()
    {
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    /// <summary>The first message; <paramref name="platform"/>: <c>windows</c> or <c>macos</c> (§2).</summary>
    public static string Hello(string token, string version, string? lastId, string platform = "windows") => Json(new JsonObject
    {
        ["type"] = "hello",
        ["token"] = token,
        ["kind"] = "computer",
        ["version"] = version,
        ["last_id"] = lastId,
        ["platform"] = platform,
    });

    public static string Ping() => Json(new JsonObject { ["type"] = "ping" });

    /// <summary>
    /// The offer; <paramref name="code"/>: Claude Code jobs are shared (device-contracts.md §7);
    /// <paramref name="codeStart"/>: Anemo may start and cancel them (§7.4). <c>code_images</c>:
    /// a <c>code_start</c> may carry images (1.3.0); always so where starting is offered.
    /// <c>code_git</c>: the read-only git actions <c>code_git_graph</c> and <c>code_git_commit</c>
    /// are there (§7.5, 1.5.0); offered with sharing, which they need. <c>code_git_remote</c>: they
    /// also take <c>repo</c> and <c>fetch</c>, and <c>code_git_cache_clear</c> is there (§7.6, 1.6.0);
    /// always with <c>code_git</c>.
    /// <paramref name="shellKind"/>: powershell, pwsh, zsh or bash (§2, 1.4.0).
    /// <paramref name="files"/>: the file actions of §8 are there (1.7.0): the switch is on and the device is trusted.
    /// </summary>
    public static string Offer(bool control, bool shell, bool code, bool codeStart, string shellKind = "powershell", bool files = false) => Json(new JsonObject
    {
        ["type"] = "device.offer",
        ["control"] = control,
        ["shell"] = shell,
        ["code"] = code,
        ["code_start"] = codeStart,
        ["code_images"] = codeStart,
        ["code_git"] = code,
        ["code_git_remote"] = code,
        ["shell_kind"] = shellKind,
        ["files"] = files,
    });

    public static string Stopped() => Json(new JsonObject { ["type"] = "device.stopped" });

    public static string Result(string id, CommandOutcome outcome)
    {
        var msg = new JsonObject { ["type"] = "device.result", ["id"] = id, ["ok"] = outcome.Ok };
        if (outcome.Ok)
        {
            msg["state"] = outcome.State ?? new JsonObject();
        }
        else
        {
            var error = outcome.Error ?? "Something went wrong.";
            msg["error"] = error.Length > MaxErrorLength ? error[..MaxErrorLength] : error;
            msg["code"] = outcome.Code ?? "failed";
        }

        var text = Json(msg);
        if (outcome.Ok && System.Text.Encoding.UTF8.GetByteCount(text) > MaxResultBytes)
        {
            return Result(id, CommandOutcome.Fail("failed", TooLargeMessage));
        }

        return text;
    }

    /// <summary>A server message, or null when it isn't a JSON object with a string <c>type</c>.</summary>
    public static JsonObject? Parse(string text)
    {
        try
        {
            return JsonNode.Parse(text) is JsonObject obj && Str(obj, "type") is not null ? obj : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    public static string? Type(JsonObject msg) => Str(msg, "type");

    /// <summary>The device from a <c>welcome</c>, or null when it is malformed.</summary>
    public static DeviceInfo? Device(JsonObject welcome)
    {
        if (welcome["device"] is not JsonObject d)
        {
            return null;
        }

        var id = Str(d, "id");
        var trust = Str(d, "trust");
        if (id is null || trust is null)
        {
            return null;
        }

        return new DeviceInfo(id, Str(d, "name") ?? "", Str(d, "kind") ?? "computer", trust);
    }

    /// <summary>A string field, or null when it is missing or not a string.</summary>
    public static string? Str(JsonObject obj, string key) =>
        obj[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    /// <summary>A number field (parsed or built in code), or null when it is missing or not a number.</summary>
    public static double? Number(JsonNode? node)
    {
        if (node is not JsonValue v)
        {
            return null;
        }

        if (v.TryGetValue<double>(out var d))
        {
            return d;
        }

        if (v.TryGetValue<long>(out var l))
        {
            return l;
        }

        if (v.TryGetValue<int>(out var i))
        {
            return i;
        }

        return v.TryGetValue<decimal>(out var m) ? (double)m : null;
    }

    /// <summary>Compact JSON as every message is sent.</summary>
    internal static string Json(JsonNode node) => node.ToJsonString(Relaxed);
}
