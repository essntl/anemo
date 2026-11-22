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

    public static string Hello(string token, string version, string? lastId) => Json(new JsonObject
    {
        ["type"] = "hello",
        ["token"] = token,
        ["kind"] = "computer",
        ["version"] = version,
        ["last_id"] = lastId,
    });

    public static string Ping() => Json(new JsonObject { ["type"] = "ping" });

    public static string Offer(bool control, bool shell) => Json(new JsonObject
    {
        ["type"] = "device.offer",
        ["control"] = control,
        ["shell"] = shell,
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

        return Json(msg);
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

    private static string Json(JsonNode node) => node.ToJsonString();
}
