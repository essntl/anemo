using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anemo.Desktop.Core.CodeJobs;

/// <summary>What <c>meta.json</c> says about a job (unknown fields are ignored).</summary>
public sealed record JobMeta(
    int? Pid,
    string Dir,
    string? ResumeSession,
    DateTimeOffset Started,
    string? PromptPreview,
    string? Model,
    bool Input = false); // meta.json "input": "stream-json": the job takes messages while it runs (§15, 1.9.0)

/// <summary>
/// Reads one job folder of <c>cc.ps1</c>'s format (code-sessions.md D2):
/// <c>prompt.txt</c>, <c>out.jsonl</c>, <c>err.txt</c>, <c>meta.json</c>, <c>cancelled</c>.
/// Every file is opened so that the job can keep writing, renaming or deleting it.
/// Nothing here throws for a missing or half-written file; the caller retries later.
/// </summary>
public static partial class JobFolder
{
    public const string Meta = "meta.json";
    public const string Prompt = "prompt.txt";
    public const string Out = "out.jsonl";
    public const string Err = "err.txt";
    public const string Cancelled = "cancelled";

    /// <summary>The job folder is made and Anemo Desktop is still cloning or making its project (§12.5).</summary>
    public const string Starting = "starting";

    public static bool IsJobId(string name) => IdPattern().IsMatch(name) && IdTime(name) is not null;

    /// <summary>
    /// The time in a job id (<c>yyyyMMdd-HHmmss-xxxx</c>), read as UTC. The id holds the
    /// computer's local time, so this is off by the time zone; it is only used to age jobs
    /// by days.
    /// </summary>
    public static DateTimeOffset? IdTime(string id) =>
        id.Length >= 15 && DateTime.TryParseExact(
            id[..15], "yyyyMMdd-HHmmss", CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var t)
            ? new DateTimeOffset(t, TimeSpan.Zero)
            : null;

    /// <summary>The meta, or null when <c>meta.json</c> is missing or doesn't read (yet).</summary>
    public static JobMeta? ReadMeta(string folder, string id)
    {
        var text = ReadText(Path.Combine(folder, Meta));
        if (text is null)
        {
            return null;
        }

        JsonObject? meta;
        try
        {
            meta = JsonNode.Parse(text) as JsonObject;
        }
        catch (Exception e) when (e is JsonException or ArgumentException or InvalidOperationException)
        {
            return null;
        }

        if (meta is null)
        {
            return null;
        }

        var started = ParseTime(Str(meta, "started")) ?? LocalIdTime(id);
        if (started is null)
        {
            return null;
        }

        return new JobMeta(
            Int(meta["pid"]),
            Str(meta, "dir") ?? "",
            NullIfBlank(Str(meta, "resume")),
            started.Value,
            Str(meta, "prompt_preview"),
            NullIfBlank(Str(meta, "model")),
            Str(meta, "input") == JobFeeder.MetaInput);
    }

    /// <summary><c>prompt.txt</c>, or the meta's preview when it is missing.</summary>
    public static string ReadPrompt(string folder, JobMeta meta) =>
        ReadText(Path.Combine(folder, Prompt)) ?? meta.PromptPreview ?? "";

    public static bool IsCancelled(string folder) => File.Exists(Path.Combine(folder, Cancelled));

    /// <summary>The last write to <c>out.jsonl</c> or <c>err.txt</c>, or null when neither exists.</summary>
    public static DateTimeOffset? LastOutputAt(string folder)
    {
        DateTimeOffset? last = null;
        foreach (var name in new[] { Out, Err })
        {
            var path = Path.Combine(folder, name);
            if (File.Exists(path) && new DateTimeOffset(File.GetLastWriteTimeUtc(path), TimeSpan.Zero) is var at && (last is null || at > last))
            {
                last = at;
            }
        }

        return last;
    }

    /// <summary>
    /// When the job ended, as far as the folder tells: the <c>cancelled</c> file's time, else
    /// the last write to <c>out.jsonl</c> (else <c>meta.json</c>). Stable across restarts.
    /// </summary>
    public static DateTimeOffset EndedAt(string folder, bool cancelled)
    {
        foreach (var name in cancelled ? new[] { Cancelled, Out, Meta } : new[] { Out, Meta })
        {
            var path = Path.Combine(folder, name);
            if (File.Exists(path))
            {
                return new DateTimeOffset(File.GetLastWriteTimeUtc(path), TimeSpan.Zero);
            }
        }

        return DateTimeOffset.UtcNow;
    }

    /// <summary>
    /// The last characters of <c>err.txt</c>, or null when it is missing or empty. The encoding
    /// comes from the file's byte order mark (UTF-16 from Windows PowerShell, UTF-8 otherwise),
    /// also when only the end of a large file is read.
    /// </summary>
    public static string? StderrTail(string folder, int maxChars = CodeJobLimits.MaxStderrChars)
    {
        try
        {
            using var stream = OpenShared(Path.Combine(folder, Err));
            var (encoding, bom, unit) = DetectEncoding(stream);
            var maxBytes = (long)maxChars * 4;
            var start = (long)bom;
            var cut = stream.Length - bom > maxBytes;
            if (cut)
            {
                // From a code unit's start, so UTF-16 isn't read one byte off.
                start = bom + (stream.Length - maxBytes - bom + unit - 1) / unit * unit;
            }

            stream.Seek(start, SeekOrigin.Begin);
            using var bytes = new MemoryStream();
            stream.CopyTo(bytes);
            var text = encoding.GetString(bytes.GetBuffer(), 0, (int)bytes.Length);
            if (cut)
            {
                text = text.TrimStart('\uFFFD'); // a UTF-8 character cut in half at the start
                if (text.Length > 0 && char.IsLowSurrogate(text[0]))
                {
                    text = text[1..]; // the second half of a UTF-16 pair
                }
            }

            text = Tail(text, maxChars);
            return text.Length == 0 ? null : text;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>
    /// The branch checked out in <paramref name="dir"/>, from <c>.git/HEAD</c> (or the HEAD of
    /// the worktree a <c>.git</c> file points to); null when detached or not a repository.
    /// </summary>
    public static string? Branch(string dir)
    {
        if (string.IsNullOrWhiteSpace(dir))
        {
            return null;
        }

        try
        {
            var git = Path.Combine(dir, ".git");
            string? head;
            if (Directory.Exists(git))
            {
                head = ReadText(Path.Combine(git, "HEAD"));
            }
            else if (ReadText(git) is { } pointer && pointer.StartsWith("gitdir:", StringComparison.Ordinal))
            {
                var gitDir = pointer["gitdir:".Length..].Trim();
                if (!Path.IsPathRooted(gitDir))
                {
                    gitDir = Path.GetFullPath(Path.Combine(dir, gitDir));
                }

                head = ReadText(Path.Combine(gitDir, "HEAD"));
            }
            else
            {
                return null;
            }

            const string prefix = "ref: refs/heads/";
            head = head?.Trim();
            if (head is null || !head.StartsWith(prefix, StringComparison.Ordinal))
            {
                return null;
            }

            var branch = head[prefix.Length..];
            return branch.Length == 0 ? null : Cut(branch, CodeJobLimits.MaxBranchChars);
        }
        catch (Exception e) when (e is ArgumentException or NotSupportedException or IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>The last segment of a Windows (or POSIX) path: <c>C:\dev\anemo\</c> → <c>anemo</c>.</summary>
    public static string Project(string dir)
    {
        var trimmed = dir.TrimEnd('\\', '/');
        var cut = trimmed.LastIndexOfAny(['\\', '/']);
        return cut < 0 ? trimmed : trimmed[(cut + 1)..];
    }

    /// <summary>The first <paramref name="max"/> UTF-16 units, never half a surrogate pair.</summary>
    public static string Cut(string text, int max)
    {
        if (text.Length <= max)
        {
            return text;
        }

        var end = char.IsHighSurrogate(text[max - 1]) ? max - 1 : max;
        return text[..end];
    }

    /// <summary>The last <paramref name="max"/> UTF-16 units, never half a surrogate pair.</summary>
    public static string Tail(string text, int max)
    {
        if (text.Length <= max)
        {
            return text;
        }

        var start = text.Length - max;
        if (char.IsLowSurrogate(text[start]))
        {
            start++;
        }

        return text[start..];
    }

    /// <summary>Opens a file for reading while the job may still write, rename or delete it.</summary>
    public static FileStream OpenShared(string path) =>
        new(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);

    /// <summary>
    /// <c>meta.json</c>'s <c>started</c>: ISO 8601 (with or without an offset; without one it is
    /// local time), or Windows PowerShell 5.1's <c>/Date(ms)/</c>.
    /// </summary>
    internal static DateTimeOffset? ParseTime(string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return null;
        }

        if (MsDatePattern().Match(text) is { Success: true } ms && long.TryParse(ms.Groups[1].Value, out var millis))
        {
            return DateTimeOffset.FromUnixTimeMilliseconds(millis);
        }

        return DateTimeOffset.TryParse(
            text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeLocal | DateTimeStyles.AllowWhiteSpaces, out var t)
            ? t
            : null;
    }

    /// <summary>The encoding a file's byte order mark names (UTF-8 without one), the mark's length and the code unit size.</summary>
    private static (Encoding Encoding, int Bom, int Unit) DetectEncoding(FileStream stream)
    {
        Span<byte> head = stackalloc byte[3];
        var read = stream.Read(head);
        if (read >= 2 && head[0] == 0xFF && head[1] == 0xFE)
        {
            return (new UnicodeEncoding(bigEndian: false, byteOrderMark: false), 2, 2);
        }

        if (read >= 2 && head[0] == 0xFE && head[1] == 0xFF)
        {
            return (new UnicodeEncoding(bigEndian: true, byteOrderMark: false), 2, 2);
        }

        return read == 3 && head[0] == 0xEF && head[1] == 0xBB && head[2] == 0xBF
            ? (new UTF8Encoding(false), 3, 1)
            : (new UTF8Encoding(false), 0, 1);
    }

    private static DateTimeOffset? LocalIdTime(string id) =>
        DateTime.TryParseExact(id.Length >= 15 ? id[..15] : id, "yyyyMMdd-HHmmss", CultureInfo.InvariantCulture, DateTimeStyles.AssumeLocal, out var t)
            ? new DateTimeOffset(t)
            : null;

    private static string? ReadText(string path)
    {
        try
        {
            using var stream = OpenShared(path);
            using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
            return reader.ReadToEnd();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return null;
        }
    }

    private static string? Str(JsonObject obj, string key) =>
        obj[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    private static int? Int(JsonNode? node)
    {
        if (node is not JsonValue v)
        {
            return null;
        }

        if (v.TryGetValue<string>(out var s))
        {
            return int.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out var p) && p > 0 ? p : null;
        }

        return Protocol.Wire.Number(v) is { } d && d >= 1 && d <= int.MaxValue && d == Math.Floor(d) ? (int)d : null;
    }

    private static string? NullIfBlank(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();

    [GeneratedRegex(@"^\d{8}-\d{6}-[A-Za-z0-9]{4}\z")]
    private static partial Regex IdPattern();

    [GeneratedRegex(@"^\s*\\?/Date\((-?\d+)(?:[+-]\d{4})?\)\\?/\s*\z")]
    private static partial Regex MsDatePattern();
}
