using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anemo.Desktop.Core.CodeJobs;

namespace Anemo.Desktop.Tests.CodeJobs;

/// <summary>code-sessions.md §6, step by step, and the byte limit.</summary>
public sealed class TrimmerTests
{
    private const string Marker = "\n… [{0} characters trimmed] …\n";

    [Fact]
    public void A_small_event_is_sent_as_it_is()
    {
        var line = CodeEvents.Bash("toolu_1", "git status");

        var prepared = EventTrimmer.FromLine(line);

        Assert.False(prepared.Trimmed);
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(line), prepared.Event));
    }

    [Fact]
    public void Step_1_removes_the_known_copies_even_when_the_event_is_small()
    {
        var read = JsonNode.Parse(CodeEvents.ReadResult("toolu_1", "# Anemo\nshort"))!.AsObject();
        read["tool_use_result"]!["originalFile"] = "old text";
        read["tool_use_result"]!["content"] = "written text";

        var prepared = EventTrimmer.Trim(read);

        Assert.True(prepared.Trimmed);
        var result = prepared.Event["tool_use_result"]!.AsObject();
        Assert.False(result.ContainsKey("originalFile"));
        Assert.False(result.ContainsKey("content"));
        Assert.False(result["file"]!.AsObject().ContainsKey("content"));
        Assert.Equal("C:\\dev\\anemo\\README.md", (string?)result["file"]!["filePath"]);
        // The tool result itself is kept.
        Assert.Equal("# Anemo\nshort", (string?)prepared.Event["message"]!["content"]![0]!["content"]);
        // The original is untouched.
        Assert.True(read["tool_use_result"]!.AsObject().ContainsKey("originalFile"));
    }

    [Fact]
    public void A_tool_use_result_that_is_a_string_is_left_alone()
    {
        var ev = new JsonObject { ["type"] = "user", ["tool_use_result"] = "Error: file not found" };

        var prepared = EventTrimmer.Trim(ev);

        Assert.False(prepared.Trimmed);
        Assert.Equal("Error: file not found", (string?)prepared.Event["tool_use_result"]);
    }

    [Fact]
    public void Step_2_cuts_long_strings_to_1500_and_400_characters()
    {
        var output = Numbered(20_000);
        var ev = JsonNode.Parse(CodeEvents.BashResult("toolu_1", output))!.AsObject();

        var prepared = EventTrimmer.Trim(ev);

        Assert.True(prepared.Trimmed);
        var expected = output[..1500] + string.Format(Marker, 20_000 - 1900) + output[^400..];
        Assert.Equal(expected, (string?)prepared.Event["message"]!["content"]![0]!["content"]);
        Assert.Equal(expected, (string?)prepared.Event["tool_use_result"]!["stdout"]);
        Assert.True(EventTrimmer.CompactSize(prepared.Event) <= CodeJobLimits.MaxEventBytes);
        Assert.Equal("toolu_1", (string?)prepared.Event["message"]!["content"]![0]!["tool_use_id"]);
    }

    [Fact]
    public void Step_3_cuts_to_400_and_100_when_step_2_is_not_enough()
    {
        var ev = new JsonObject { ["type"] = "user", ["parts"] = new JsonArray() };
        var text = Numbered(2500);
        for (var i = 0; i < 12; i++)
        {
            ev["parts"]!.AsArray().Add(text);
        }

        // Cut to 1500 + 400 each, the twelve strings would still be over 16 000 bytes.
        Assert.True(12 * EventTrimmer.CutString(text, 1500, 400).Length > CodeJobLimits.MaxEventBytes);
        var prepared = EventTrimmer.Trim(ev);

        Assert.True(prepared.Trimmed);
        var expected = text[..400] + string.Format(Marker, 2500 - 500) + text[^100..];
        Assert.All(prepared.Event["parts"]!.AsArray(), p => Assert.Equal(expected, (string?)p));
        Assert.True(EventTrimmer.CompactSize(prepared.Event) <= CodeJobLimits.MaxEventBytes);
    }

    [Fact]
    public void Step_4_leaves_a_stub_with_the_tool_calls()
    {
        // Many strings under 2000 characters: steps 2 and 3 cut nothing.
        var input = new JsonObject();
        for (var i = 0; i < 20; i++)
        {
            input[$"f{i}"] = new string('y', 1500);
        }

        var ev = new JsonObject
        {
            ["type"] = "assistant",
            ["subtype"] = "x",
            ["message"] = new JsonObject
            {
                ["content"] = new JsonArray(
                    new JsonObject { ["type"] = "text", ["text"] = "Writing the files." },
                    new JsonObject { ["type"] = "tool_use", ["id"] = "toolu_9", ["name"] = "MultiEdit", ["input"] = input }),
            },
        };

        var prepared = EventTrimmer.Trim(ev);

        Assert.True(prepared.Trimmed);
        Assert.Equal(
            """{"type":"assistant","subtype":"x","anemo_trimmed":"too large","message":{"content":[{"type":"tool_use","name":"MultiEdit","id":"toolu_9"}]}}""",
            prepared.Event.ToJsonString());
    }

    [Fact]
    public void The_stub_has_no_subtype_or_message_when_the_event_had_none()
    {
        var ev = new JsonObject { ["type"] = "user", ["big"] = new JsonArray(Enumerable.Range(0, 20).Select(_ => (JsonNode)new string('z', 1500)).ToArray()) };

        Assert.Equal("""{"type":"user","anemo_trimmed":"too large"}""", EventTrimmer.Trim(ev).Event.ToJsonString());
    }

    [Fact]
    public void The_limit_is_bytes_of_UTF_8_not_characters()
    {
        // 5 × 1900 characters: 9500 characters either way, but 19 000 bytes in Cyrillic.
        JsonObject Event(char c) => new()
        {
            ["type"] = "assistant",
            ["parts"] = new JsonArray(Enumerable.Range(0, 5).Select(_ => (JsonNode)new string(c, 1900)).ToArray()),
        };

        Assert.False(EventTrimmer.Trim(Event('a')).Trimmed);
        var cyrillic = EventTrimmer.Trim(Event('ж'));
        Assert.True(cyrillic.Trimmed);
        Assert.Equal(EventTrimmer.TooLarge, (string?)cyrillic.Event["anemo_trimmed"]);
    }

    [Fact]
    public void An_event_of_exactly_the_limit_is_not_trimmed_one_byte_more_is()
    {
        // Strings under 2000 characters, so that only the size decides.
        var parts = new JsonArray();
        var ev = new JsonObject { ["type"] = "assistant", ["parts"] = parts };
        while (CodeJobLimits.MaxEventBytes - EventTrimmer.CompactSize(ev) > 1600)
        {
            parts.Add(new string('q', 1500));
        }

        var rest = CodeJobLimits.MaxEventBytes - EventTrimmer.CompactSize(ev) - 3; // a comma and two quotes
        parts.Add(new string('q', (int)rest));

        Assert.Equal(CodeJobLimits.MaxEventBytes, EventTrimmer.CompactSize(ev));
        Assert.Equal(CodeJobLimits.MaxEventBytes, Encoding.UTF8.GetByteCount(ev.ToJsonString()));
        Assert.False(EventTrimmer.Trim(ev).Trimmed);

        parts[^1] = new string('q', (int)rest + 1);
        Assert.True(EventTrimmer.Trim(ev).Trimmed);
    }

    [Fact]
    public void Compact_size_counts_as_Python_json_dumps_does()
    {
        Assert.Equal(Encoding.UTF8.GetByteCount("""{"a":1,"b":[true,false,null],"c":"x"}"""), EventTrimmer.CompactSize(JsonNode.Parse("""{ "a": 1, "b": [true, false, null], "c": "x" }""")));
        // Escapes: \" \\ \n are two bytes, other control characters six (\u0001).
        Assert.Equal(2 + 2 + 2 + 2 + 6, EventTrimmer.CompactSize(JsonValue.Create("\"\\\n\u0001")));
        // Non-ASCII as its UTF-8 bytes: é 2, € 3, an emoji 4.
        Assert.Equal(2 + 2 + 3 + 4, EventTrimmer.CompactSize(JsonValue.Create("é€😀")));
        Assert.Equal(Encoding.UTF8.GetByteCount("1.5e-07"), EventTrimmer.CompactSize(JsonNode.Parse("[1.5e-07]")!.AsArray()[0]));
    }

    [Fact]
    public void Compact_size_matches_the_serialized_length_of_ordinary_text()
    {
        var line = CodeEvents.ReadResult("toolu_1", "Grüße\n\t\"quoted\" \\ path C:\\dev");
        var node = JsonNode.Parse(line)!;
        var compact = node.ToJsonString(new JsonSerializerOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping });

        Assert.Equal(Encoding.UTF8.GetByteCount(compact), EventTrimmer.CompactSize(node));
    }

    [Fact]
    public void Lengths_are_code_points_so_emoji_are_never_split()
    {
        var text = string.Concat(Enumerable.Repeat("😀", 2500)); // 5000 UTF-16 units, 2500 code points

        var cut = EventTrimmer.CutString(text, 1500, 400);

        var expected = string.Concat(Enumerable.Repeat("😀", 1500)) + string.Format(Marker, 600) + string.Concat(Enumerable.Repeat("😀", 400));
        Assert.Equal(expected, cut);
        // 1999 UTF-16 units of emoji are 1000 code points: not long.
        var short_ = text[..3998];
        Assert.Same(short_, EventTrimmer.CutString(short_, 1500, 400));
    }

    [Fact]
    public void A_string_of_2000_code_points_is_not_cut()
    {
        var text = new string('a', 2000);

        Assert.Same(text, EventTrimmer.CutString(text, 1500, 400));
        Assert.NotSame(text + "a", EventTrimmer.CutString(text + "a", 1500, 400));
    }

    [Fact]
    public void A_line_that_is_not_a_JSON_object_becomes_raw_text()
    {
        Assert.Equal("""{"type":"raw","text":"Error: something broke"}""", EventTrimmer.FromLine("Error: something broke").Event.ToJsonString());
        Assert.Equal("raw", (string?)EventTrimmer.FromLine("[1,2,3]").Event["type"]);
        Assert.Equal("raw", (string?)EventTrimmer.FromLine("{\"type\":\"assistant\",").Event["type"]);
        Assert.Equal("raw", (string?)EventTrimmer.FromLine("{\"a\":1,\"a\":2}").Event["type"]);
        Assert.False(EventTrimmer.FromLine("plain").Trimmed);
    }

    [Fact]
    public void A_long_raw_line_is_cut_to_2000_characters()
    {
        var prepared = EventTrimmer.FromLine(new string('r', 5000));

        Assert.True(prepared.Trimmed);
        Assert.Equal(2000, ((string?)prepared.Event["text"])!.Length);
    }

    private static string Numbered(int length)
    {
        var text = new StringBuilder();
        for (var i = 0; text.Length < length; i++)
        {
            text.Append(i).Append(' ');
        }

        return text.ToString(0, length);
    }
}
