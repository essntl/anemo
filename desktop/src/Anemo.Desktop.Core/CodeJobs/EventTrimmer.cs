using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Anemo.Desktop.Core.CodeJobs;

/// <summary>One line of <c>out.jsonl</c> as it is sent: the event and whether anything was cut.</summary>
public sealed record PreparedEvent(JsonObject Event, bool Trimmed);

/// <summary>
/// The trimming of code-sessions.md §6, the same on both sides. Sizes are bytes of compact
/// UTF-8 JSON as the server measures them (Python's <c>json.dumps(…, separators=(",", ":"),
/// ensure_ascii=False)</c>, see <see cref="CompactSize"/>); string lengths are counted in
/// Unicode code points, as Python counts them.
/// </summary>
public static class EventTrimmer
{
    public const string TooLarge = "too large";

    /// <summary>Step 2: strings longer than 2000 code points keep their first 1500 and last 400.</summary>
    public static readonly (int LongerThan, int Head, int Tail) LongCut = (2000, 1500, 400);

    /// <summary>Step 3 (from step 1's event): strings longer than 600 keep their first 400 and last 100.</summary>
    public static readonly (int LongerThan, int Head, int Tail) ShortCut = (600, 400, 100);

    /// <summary><c>tool_use_result.type</c> of a Write, whose <c>content</c> is also in the call's input.</summary>
    private static readonly string[] WriteResultTypes = ["create", "update"];

    /// <summary>A line of <c>out.jsonl</c>: its JSON object trimmed, or a <c>raw</c> event.</summary>
    public static PreparedEvent FromLine(string line, int limit = CodeJobLimits.MaxEventBytes)
    {
        try
        {
            if (JsonNode.Parse(line) is JsonObject ev)
            {
                _ = ev.Count; // duplicate keys throw here, not later
                return Trim(ev, limit);
            }
        }
        catch (Exception e) when (e is JsonException or ArgumentException or InvalidOperationException)
        {
            // Not a JSON object: sent as raw text below.
        }

        var text = JobFolder.Cut(line, CodeJobLimits.MaxRawChars);
        return new PreparedEvent(new JsonObject { ["type"] = "raw", ["text"] = text }, text.Length < line.Length);
    }

    /// <summary>Trims one event to at most <paramref name="limit"/> bytes (§6, steps 1–4).</summary>
    public static PreparedEvent Trim(JsonObject ev, int limit = CodeJobLimits.MaxEventBytes)
    {
        // 1. Known copies of text that is elsewhere in the event or the log.
        var work = (JsonObject)ev.DeepClone();
        var trimmed = RemoveCopies(work);
        if (CompactSize(work) <= limit)
        {
            return new PreparedEvent(work, trimmed);
        }

        // 2. and 3. Long strings cut to their head and tail; each step starts from step 1's event.
        foreach (var (longerThan, head, tail) in new[] { LongCut, ShortCut })
        {
            var cut = CutStrings(work.DeepClone(), longerThan, head, tail);
            if (CompactSize(cut) <= limit)
            {
                return new PreparedEvent((JsonObject)cut!, true);
            }
        }

        // 4. A stub: the type, the subtype and the tool calls' names and ids.
        return new PreparedEvent(Stub(work), true);
    }

    /// <summary>
    /// Bytes of <paramref name="node"/> as compact UTF-8 JSON without ASCII escaping:
    /// <c>"</c>, <c>\</c> and control characters escaped as Python escapes them, everything
    /// else as its UTF-8 bytes; numbers as written.
    /// </summary>
    public static long CompactSize(JsonNode? node)
    {
        switch (node)
        {
            case null:
                return 4;
            case JsonObject obj:
            {
                long size = 2 + Math.Max(0, obj.Count - 1);
                foreach (var (key, child) in obj)
                {
                    size += StringSize(key) + 1 + CompactSize(child);
                }

                return size;
            }

            case JsonArray array:
            {
                long size = 2 + Math.Max(0, array.Count - 1);
                foreach (var item in array)
                {
                    size += CompactSize(item);
                }

                return size;
            }

            default:
                var value = node.AsValue();
                return value.GetValueKind() switch
                {
                    JsonValueKind.String => StringSize(value.GetValue<string>()),
                    JsonValueKind.True => 4,
                    JsonValueKind.False => 5,
                    JsonValueKind.Null => 4,
                    _ => Encoding.UTF8.GetByteCount(value.ToJsonString()),
                };
        }
    }

    /// <summary>
    /// <paramref name="text"/> cut to its first <paramref name="head"/> and last
    /// <paramref name="tail"/> code points when it is longer than
    /// <paramref name="longerThan"/> code points; the same instance otherwise.
    /// </summary>
    public static string CutString(string text, int longerThan, int head, int tail)
    {
        if (text.Length <= longerThan)
        {
            return text; // UTF-16 length ≥ code points
        }

        var points = CodePoints(text);
        if (points <= longerThan)
        {
            return text;
        }

        var headEnd = IndexOfCodePoint(text, head);
        var tailStart = IndexOfCodePoint(text, points - tail);
        return string.Concat(text.AsSpan(0, headEnd), $"\n… [{points - head - tail} characters trimmed] …\n", text.AsSpan(tailStart));
    }

    private static bool RemoveCopies(JsonObject ev)
    {
        if (ev["tool_use_result"] is not JsonObject result)
        {
            return false;
        }

        var removed = result.Remove("originalFile");
        if (result["file"] is JsonObject file)
        {
            removed |= file.Remove("content"); // Read
        }

        if (result["type"] is JsonValue type && type.GetValueKind() == JsonValueKind.String
            && WriteResultTypes.Contains(type.GetValue<string>()))
        {
            removed |= result.Remove("content"); // Write
        }

        return removed;
    }

    /// <summary>Cuts every long string in place (a node keeps its parent, so only cut strings are replaced).</summary>
    private static JsonNode? CutStrings(JsonNode? node, int longerThan, int head, int tail)
    {
        switch (node)
        {
            case JsonObject obj:
                foreach (var key in obj.Select(p => p.Key).ToList())
                {
                    if (Replacement(obj[key], longerThan, head, tail) is { } cut)
                    {
                        obj[key] = cut;
                    }
                    else
                    {
                        CutStrings(obj[key], longerThan, head, tail);
                    }
                }

                break;
            case JsonArray array:
                for (var i = 0; i < array.Count; i++)
                {
                    if (Replacement(array[i], longerThan, head, tail) is { } cut)
                    {
                        array[i] = cut;
                    }
                    else
                    {
                        CutStrings(array[i], longerThan, head, tail);
                    }
                }

                break;
        }

        return node;
    }

    /// <summary>A new value when <paramref name="node"/> is a string that gets cut, else null.</summary>
    private static JsonValue? Replacement(JsonNode? node, int longerThan, int head, int tail)
    {
        if (node is not JsonValue value || value.GetValueKind() != JsonValueKind.String)
        {
            return null;
        }

        var text = value.GetValue<string>();
        var cut = CutString(text, longerThan, head, tail);
        return ReferenceEquals(cut, text) ? null : JsonValue.Create(cut);
    }

    /// <summary>
    /// Short fields that say where an event belongs (the sub-agent of <c>parent_tool_use_id</c>)
    /// and what it ends (a background sub-agent's <c>tool_use_id</c> and <c>status</c>): a stub
    /// keeps them, as the server does (code-sessions.md §6 step 4).
    /// </summary>
    private static readonly string[] Placing = ["parent_tool_use_id", "tool_use_id", "status"];

    /// <summary>The fields a stub keeps of a content block, by the block's type.</summary>
    private static readonly Dictionary<string, string[]> KeptBlockFields = new(StringComparer.Ordinal)
    {
        ["tool_use"] = ["type", "name", "id"],
        ["tool_result"] = ["type", "tool_use_id", "is_error"],
    };

    private const int MaxKeptChars = 200;

    /// <summary>A text of at most 200 characters, or true / false: a value a stub may keep.</summary>
    private static bool IsShort(JsonNode? node) => node is JsonValue v && v.GetValueKind() switch
    {
        JsonValueKind.True or JsonValueKind.False => true,
        JsonValueKind.String => v.GetValue<string>().Length <= MaxKeptChars,
        _ => false,
    };

    private static JsonObject Stub(JsonObject ev)
    {
        var stub = new JsonObject { ["type"] = ev["type"]?.DeepClone() };
        if (ev.ContainsKey("subtype"))
        {
            stub["subtype"] = ev["subtype"]?.DeepClone();
        }

        foreach (var key in Placing)
        {
            if (IsShort(ev[key]))
            {
                stub[key] = ev[key]!.DeepClone();
            }
        }

        stub["anemo_trimmed"] = TooLarge;
        if (ev["message"] is JsonObject { } message && message["content"] is JsonArray content)
        {
            var kept = new JsonArray();
            foreach (var block in content.OfType<JsonObject>())
            {
                if (block["type"] is JsonValue t && t.GetValueKind() == JsonValueKind.String
                    && KeptBlockFields.TryGetValue(t.GetValue<string>(), out var fields))
                {
                    var part = new JsonObject();
                    foreach (var key in fields)
                    {
                        if (block.ContainsKey(key) && IsShort(block[key]))
                        {
                            part[key] = block[key]!.DeepClone();
                        }
                    }

                    kept.Add(part);
                }
            }

            if (kept.Count > 0)
            {
                stub["message"] = new JsonObject { ["content"] = kept };
            }
        }

        return stub;
    }

    private static long StringSize(string text)
    {
        long size = 2;
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            if (c is '"' or '\\' or '\b' or '\f' or '\n' or '\r' or '\t')
            {
                size += 2;
            }
            else if (c < 0x20)
            {
                size += 6;
            }
            else if (c < 0x80)
            {
                size += 1;
            }
            else if (c < 0x800)
            {
                size += 2;
            }
            else if (char.IsHighSurrogate(c) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1]))
            {
                size += 4;
                i++;
            }
            else
            {
                size += 3;
            }
        }

        return size;
    }

    private static int CodePoints(string text)
    {
        var count = 0;
        for (var i = 0; i < text.Length; i++)
        {
            if (char.IsHighSurrogate(text[i]) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1]))
            {
                i++;
            }

            count++;
        }

        return count;
    }

    /// <summary>The UTF-16 index where code point number <paramref name="point"/> (0-based) starts.</summary>
    private static int IndexOfCodePoint(string text, int point)
    {
        var i = 0;
        for (var n = 0; n < point && i < text.Length; n++)
        {
            i += char.IsHighSurrogate(text[i]) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1]) ? 2 : 1;
        }

        return i;
    }
}
