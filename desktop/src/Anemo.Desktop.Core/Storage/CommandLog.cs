using System.Text.Json;
using System.Text.Json.Nodes;

namespace Anemo.Desktop.Core.Storage;

/// <summary>
/// The local log of commands: one JSON line per command (time, action, summary, outcome),
/// one file per day, the last 7 days kept. Never screenshots, typed text or commands'
/// output: the summary is made by <see cref="Commands.CommandSummary"/>.
/// </summary>
public sealed class CommandLog
{
    public static readonly TimeSpan KeepFor = TimeSpan.FromDays(7);

    private const string Prefix = "commands-";
    private static readonly JsonSerializerOptions Readable = new()
    {
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private readonly string _folder;
    private readonly TimeProvider _time;
    private readonly object _lock = new();
    private DateOnly? _prunedOn;

    public CommandLog(string folder, TimeProvider time)
    {
        _folder = folder;
        _time = time;
    }

    public void Write(string action, string summary, bool ok, string? code)
    {
        var now = _time.GetUtcNow();
        var line = new JsonObject
        {
            ["at"] = now.ToString("O"),
            ["action"] = action,
            ["summary"] = summary,
            ["ok"] = ok,
            ["code"] = code,
        }.ToJsonString(Readable);

        lock (_lock)
        {
            try
            {
                Directory.CreateDirectory(_folder);
                File.AppendAllText(FileFor(DateOnly.FromDateTime(now.UtcDateTime)), line + "\n");
                PruneOncePerDay(now);
            }
            catch (IOException)
            {
                // The log is a convenience; a full disk must not fail the command.
            }
        }
    }

    /// <summary>The entries of the kept days, oldest first.</summary>
    public IReadOnlyList<JsonObject> Read()
    {
        lock (_lock)
        {
            if (!Directory.Exists(_folder))
            {
                return [];
            }

            return Directory.GetFiles(_folder, Prefix + "*.jsonl")
                .Order(StringComparer.Ordinal)
                .SelectMany(File.ReadAllLines)
                .Select(ParseLine)
                .OfType<JsonObject>()
                .ToList();
        }
    }

    /// <summary>Deletes the files of days older than <see cref="KeepFor"/>.</summary>
    public void Prune()
    {
        lock (_lock)
        {
            PruneNow(_time.GetUtcNow());
        }
    }

    private void PruneOncePerDay(DateTimeOffset now)
    {
        var today = DateOnly.FromDateTime(now.UtcDateTime);
        if (_prunedOn != today)
        {
            PruneNow(now);
            _prunedOn = today;
        }
    }

    private void PruneNow(DateTimeOffset now)
    {
        if (!Directory.Exists(_folder))
        {
            return;
        }

        var oldest = DateOnly.FromDateTime((now - KeepFor).UtcDateTime);
        foreach (var file in Directory.GetFiles(_folder, Prefix + "*.jsonl"))
        {
            var name = System.IO.Path.GetFileNameWithoutExtension(file)[Prefix.Length..];
            if (DateOnly.TryParseExact(name, "yyyy-MM-dd", out var day) && day < oldest)
            {
                File.Delete(file);
            }
        }
    }

    private string FileFor(DateOnly day) =>
        System.IO.Path.Combine(_folder, $"{Prefix}{day:yyyy-MM-dd}.jsonl");

    private static JsonObject? ParseLine(string line)
    {
        try
        {
            return JsonNode.Parse(line) as JsonObject;
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
