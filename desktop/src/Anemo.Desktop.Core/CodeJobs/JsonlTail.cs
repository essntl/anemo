using System.Text;

namespace Anemo.Desktop.Core.CodeJobs;

/// <summary>
/// How far <c>out.jsonl</c> was read: <see cref="Seq"/> non-blank lines end at byte
/// <see cref="Offset"/>.
/// </summary>
public readonly record struct LinePosition(long Offset, long Seq)
{
    public static readonly LinePosition Start = new(0, 0);
}

/// <summary>One complete, non-blank line: its seq, its text and the offset after its <c>\n</c>.</summary>
public sealed record TailLine(long Seq, string Text, long EndOffset)
{
    public LinePosition After => new(EndOffset, Seq);
}

/// <summary>
/// Reads <c>out.jsonl</c> by byte offset (code-sessions.md §4, D6): only complete lines
/// (ending in <c>\n</c>), blank lines skipped and not counted, a UTF-8 BOM at the start
/// ignored. A missing file reads as empty.
/// </summary>
public static class JsonlTail
{
    private const int ChunkBytes = 64 * 1024;

    /// <summary>
    /// The complete non-blank lines after <paramref name="from"/>: at most
    /// <paramref name="maxLines"/>, and no more once <paramref name="maxBytes"/> of line
    /// bytes were read (always at least one line when there is one).
    /// </summary>
    public static List<TailLine> Read(string path, LinePosition from, int maxLines, long maxBytes = long.MaxValue)
    {
        var lines = new List<TailLine>();
        long bytes = 0;
        Scan(path, from, keepText: true, (seq, text, end, size) =>
        {
            lines.Add(new TailLine(seq, text!, end));
            bytes += size;
            return lines.Count < maxLines && bytes < maxBytes;
        });
        return lines;
    }

    /// <summary>
    /// Calls <paramref name="onLine"/> for every complete non-blank line after
    /// <paramref name="from"/>, one at a time; returns the position after the last one.
    /// </summary>
    public static LinePosition Each(string path, LinePosition from, Action<TailLine> onLine)
    {
        var at = from;
        Scan(path, from, keepText: true, (seq, text, end, _) =>
        {
            var line = new TailLine(seq, text!, end);
            onLine(line);
            at = line.After;
            return true;
        });
        return at;
    }

    /// <summary>
    /// The position after line <paramref name="seq"/>, counted on from <paramref name="from"/>
    /// (which must be at or before it); the position after the last complete line when the
    /// file has fewer.
    /// </summary>
    public static LinePosition Seek(string path, LinePosition from, long seq)
    {
        if (seq <= from.Seq)
        {
            return from;
        }

        var at = from;
        Scan(path, from, keepText: false, (s, _, end, _) =>
        {
            at = new LinePosition(end, s);
            return s < seq;
        });
        return at;
    }

    /// <summary>True when a complete non-blank line follows <paramref name="from"/>.</summary>
    public static bool HasLineAfter(string path, LinePosition from)
    {
        var found = false;
        Scan(path, from, keepText: false, (_, _, _, _) =>
        {
            found = true;
            return false;
        });
        return found;
    }

    /// <summary>
    /// Calls <paramref name="onLine"/>(seq, text or null, end offset, line bytes) for each
    /// complete non-blank line after <paramref name="from"/> until it returns false.
    /// </summary>
    private static void Scan(string path, LinePosition from, bool keepText, Func<long, string?, long, long, bool> onLine)
    {
        FileStream stream;
        try
        {
            stream = JobFolder.OpenShared(path);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return;
        }

        using (stream)
        {
            if (from.Offset > stream.Length)
            {
                return; // the file shrank: nothing to read from here
            }

            var position = from.Offset;
            if (position == 0 && SkipBom(stream))
            {
                position = 3;
            }

            stream.Seek(position, SeekOrigin.Begin);
            var seq = from.Seq;
            var buffer = new byte[ChunkBytes];
            using var line = new MemoryStream();
            long lineBytes = 0;
            var blank = true;
            int read;
            while ((read = stream.Read(buffer, 0, buffer.Length)) > 0)
            {
                var start = 0;
                for (var i = 0; i < read; i++)
                {
                    var b = buffer[i];
                    if (b != (byte)'\n')
                    {
                        if (b is not ((byte)' ' or (byte)'\t' or (byte)'\r'))
                        {
                            blank = false;
                        }

                        continue;
                    }

                    var count = i - start;
                    lineBytes += count;
                    var end = position + i + 1;
                    if (!blank)
                    {
                        if (keepText)
                        {
                            line.Write(buffer, start, count);
                        }

                        seq++;
                        var text = keepText ? Decode(line) : null;
                        if (!onLine(seq, text, end, lineBytes))
                        {
                            return;
                        }
                    }

                    line.SetLength(0);
                    lineBytes = 0;
                    blank = true;
                    start = i + 1;
                }

                // The unfinished rest of the chunk belongs to the next line.
                lineBytes += read - start;
                if (keepText)
                {
                    line.Write(buffer, start, read - start);
                }

                position += read;
            }
        }
    }

    private static bool SkipBom(FileStream stream)
    {
        if (stream.Length < 3)
        {
            return false;
        }

        Span<byte> head = stackalloc byte[3];
        stream.Seek(0, SeekOrigin.Begin);
        return stream.Read(head) == 3 && head[0] == 0xEF && head[1] == 0xBB && head[2] == 0xBF;
    }

    private static string Decode(MemoryStream line)
    {
        var text = Encoding.UTF8.GetString(line.GetBuffer(), 0, (int)line.Length);
        return text.TrimEnd('\r', ' ', '\t').TrimStart('﻿');
    }
}
