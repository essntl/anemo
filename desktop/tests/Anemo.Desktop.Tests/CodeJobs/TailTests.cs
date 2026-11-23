using System.Text;
using Anemo.Desktop.Core.CodeJobs;

namespace Anemo.Desktop.Tests.CodeJobs;

/// <summary>Reading out.jsonl by byte offset (code-sessions.md §4, D6).</summary>
public sealed class TailTests : IDisposable
{
    private readonly string _folder = Path.Combine(Path.GetTempPath(), "anemo-tail-tests", Guid.NewGuid().ToString("N"));
    private readonly string _path;

    public TailTests()
    {
        Directory.CreateDirectory(_folder);
        _path = Path.Combine(_folder, "out.jsonl");
    }

    public void Dispose() => Directory.Delete(_folder, true);

    [Fact]
    public void A_missing_file_reads_as_empty()
    {
        Assert.Empty(JsonlTail.Read(Path.Combine(_folder, "none.jsonl"), LinePosition.Start, 10));
        Assert.False(JsonlTail.HasLineAfter(Path.Combine(_folder, "none.jsonl"), LinePosition.Start));
    }

    [Fact]
    public void Only_complete_lines_are_read_and_the_partial_one_comes_later()
    {
        Append("{\"a\":1}\n{\"b\":2}\n{\"c\":");

        var lines = JsonlTail.Read(_path, LinePosition.Start, 10);

        Assert.Equal(["{\"a\":1}", "{\"b\":2}"], lines.Select(l => l.Text));
        Assert.Equal([1L, 2L], lines.Select(l => l.Seq));
        Assert.Equal(16, lines[^1].EndOffset);
        Assert.False(JsonlTail.HasLineAfter(_path, lines[^1].After));

        Append("3}\n");
        var next = Assert.Single(JsonlTail.Read(_path, lines[^1].After, 10));
        Assert.Equal("{\"c\":3}", next.Text);
        Assert.Equal(3, next.Seq);
        Assert.Equal(new FileInfo(_path).Length, next.EndOffset);
    }

    [Fact]
    public void Blank_lines_are_skipped_and_not_counted()
    {
        Append("\n{\"a\":1}\n\n   \n\t\r\n{\"b\":2}\r\n\n");

        var lines = JsonlTail.Read(_path, LinePosition.Start, 10);

        Assert.Equal(["{\"a\":1}", "{\"b\":2}"], lines.Select(l => l.Text));
        Assert.Equal([1L, 2L], lines.Select(l => l.Seq));
        Assert.False(JsonlTail.HasLineAfter(_path, lines[^1].After));
    }

    [Fact]
    public void A_byte_order_mark_at_the_start_is_ignored()
    {
        File.WriteAllBytes(_path, [0xEF, 0xBB, 0xBF, .. Encoding.UTF8.GetBytes("{\"a\":1}\n")]);

        var line = Assert.Single(JsonlTail.Read(_path, LinePosition.Start, 10));

        Assert.Equal("{\"a\":1}", line.Text);
        Assert.Equal(11, line.EndOffset);
    }

    [Fact]
    public void Text_is_UTF_8_and_offsets_are_bytes()
    {
        Append("{\"t\":\"Grüße ✓ 😀\"}\n{\"n\":2}\n");

        var lines = JsonlTail.Read(_path, LinePosition.Start, 10);

        Assert.Equal("{\"t\":\"Grüße ✓ 😀\"}", lines[0].Text);
        Assert.Equal(Encoding.UTF8.GetByteCount("{\"t\":\"Grüße ✓ 😀\"}\n"), lines[0].EndOffset);
    }

    [Fact]
    public void Reading_goes_on_from_the_last_position_across_restarts()
    {
        Append(string.Concat(Enumerable.Range(1, 10).Select(i => $"{{\"i\":{i}}}\n\n")));

        var first = JsonlTail.Read(_path, LinePosition.Start, 4);
        var saved = first[^1].After; // what the state file would keep
        var rest = JsonlTail.Read(_path, new LinePosition(saved.Offset, saved.Seq), 100);

        Assert.Equal([1L, 2, 3, 4], first.Select(l => l.Seq));
        Assert.Equal([5L, 6, 7, 8, 9, 10], rest.Select(l => l.Seq));
        Assert.Equal("{\"i\":5}", rest[0].Text);
    }

    [Fact]
    public void Seek_finds_the_same_positions_as_reading()
    {
        Append(string.Concat(Enumerable.Range(1, 30).Select(i => $"{{\"i\":{i}}}\n" + (i % 3 == 0 ? "\n" : ""))));
        var all = JsonlTail.Read(_path, LinePosition.Start, 100);

        Assert.Equal(all[16].After, JsonlTail.Seek(_path, LinePosition.Start, 17));
        Assert.Equal(all[16].After, JsonlTail.Seek(_path, all[4].After, 17));
        Assert.Equal(all[^1].After, JsonlTail.Seek(_path, LinePosition.Start, 500)); // fewer lines: the end
        Assert.Equal(LinePosition.Start, JsonlTail.Seek(_path, LinePosition.Start, 0));
    }

    [Fact]
    public void The_byte_budget_stops_reading_after_at_least_one_line()
    {
        Append(new string('a', 1000) + "\n" + new string('b', 1000) + "\n" + new string('c', 1000) + "\n");

        Assert.Single(JsonlTail.Read(_path, LinePosition.Start, 10, maxBytes: 10));
        Assert.Equal(2, JsonlTail.Read(_path, LinePosition.Start, 10, maxBytes: 1500).Count);
    }

    [Fact]
    public void A_growing_file_held_open_by_the_writer_is_read_as_it_grows()
    {
        using var writer = new FileStream(_path, FileMode.Create, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
        var position = LinePosition.Start;
        var seen = new List<string>();
        for (var i = 1; i <= 5; i++)
        {
            var bytes = Encoding.UTF8.GetBytes($"{{\"i\":{i}}}\n{{\"half\":");
            writer.Write(bytes);
            writer.Flush();
            foreach (var line in JsonlTail.Read(_path, position, 100))
            {
                seen.Add(line.Text);
                position = line.After;
            }

            writer.Write(Encoding.UTF8.GetBytes($"{i}}}\n"));
            writer.Flush();
        }

        foreach (var line in JsonlTail.Read(_path, position, 100))
        {
            seen.Add(line.Text);
            position = line.After;
        }

        Assert.Equal(10, seen.Count);
        Assert.Equal(10, position.Seq);
        Assert.Equal("{\"half\":5}", seen[^1]);
    }

    [Fact]
    public void A_line_longer_than_the_read_chunk_comes_whole()
    {
        var big = "{\"t\":\"" + new string('x', 200_000) + "\"}";
        Append(big + "\n{\"n\":2}\n");

        var lines = JsonlTail.Read(_path, LinePosition.Start, 10);

        Assert.Equal(big, lines[0].Text);
        Assert.Equal("{\"n\":2}", lines[1].Text);
    }

    [Fact]
    public void A_file_shorter_than_the_position_reads_as_empty()
    {
        Append("{\"a\":1}\n");

        Assert.Empty(JsonlTail.Read(_path, new LinePosition(5000, 40), 10));
    }

    private void Append(string text) => File.AppendAllText(_path, text, new UTF8Encoding(false));
}
