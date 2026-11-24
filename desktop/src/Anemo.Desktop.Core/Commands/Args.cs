using System.Text.Json.Nodes;

namespace Anemo.Desktop.Core.Commands;

/// <summary>Reads a command's fields; a bad field fails the command with a sentence.</summary>
internal sealed class Args
{
    private readonly JsonObject _command;

    public Args(JsonObject command) => _command = command;

    public bool Has(string key) => _command[key] is not null;

    /// <summary>The field as it came (a list or an object to read further), or null.</summary>
    public JsonNode? Node(string key) => _command[key];

    public string? OptionalString(string key)
    {
        var node = _command[key];
        if (node is null)
        {
            return null;
        }

        return node is JsonValue v && v.TryGetValue<string>(out var s)
            ? s
            : throw CommandException.Failed($"“{key}” must be text.");
    }

    public string String(string key, int maxLength, bool allowEmpty = false)
    {
        var s = OptionalString(key) ?? throw CommandException.Failed($"“{key}” is missing.");
        if (!allowEmpty && s.Length == 0)
        {
            throw CommandException.Failed($"“{key}” is empty.");
        }

        if (s.Length > maxLength)
        {
            throw CommandException.Failed($"“{key}” is longer than {maxLength} characters.");
        }

        return s;
    }

    public bool Bool(string key, bool fallback)
    {
        var node = _command[key];
        if (node is null)
        {
            return fallback;
        }

        return node is JsonValue v && v.TryGetValue<bool>(out var b)
            ? b
            : throw CommandException.Failed($"“{key}” must be true or false.");
    }

    public double? OptionalNumber(string key)
    {
        var node = _command[key];
        if (node is null)
        {
            return null;
        }

        if (Protocol.Wire.Number(node) is { } d && double.IsFinite(d))
        {
            return d;
        }

        throw CommandException.Failed($"“{key}” must be a number.");
    }

    public int Int(string key, int min, int max, int? fallback = null)
    {
        var d = OptionalNumber(key) ?? fallback ?? throw CommandException.Failed($"“{key}” is missing.");
        if (d != Math.Floor(d) || d < min || d > max)
        {
            throw CommandException.Failed($"“{key}” must be a whole number from {min} to {max}.");
        }

        return (int)d;
    }

    public IReadOnlyList<string> StringList(string key, int min, int max)
    {
        if (_command[key] is not JsonArray array)
        {
            throw CommandException.Failed($"“{key}” must be a list.");
        }

        if (array.Count < min || array.Count > max)
        {
            throw CommandException.Failed($"“{key}” must have {min} to {max} items.");
        }

        return array.Select(n => n is JsonValue v && v.TryGetValue<string>(out var s)
                ? s
                : throw CommandException.Failed($"Every item of “{key}” must be text."))
            .ToList();
    }
}
