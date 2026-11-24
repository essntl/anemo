using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anemo.Desktop.Core.Commands;

namespace Anemo.Desktop.Core.CodeJobs;

/// <summary>An image sent with <c>code_start</c>: the file name to write it under, and its bytes.</summary>
public sealed record CodeJobImage(string Name, byte[] Data);

/// <summary>
/// The images of a <c>code_start</c> (device-contracts.md §7.4, Anemo Desktop 1.3.0): checked,
/// written into the job's folder as <c>images\&lt;name&gt;</c>, and listed at the end of the
/// prompt by their full paths, so Claude Code opens them with its Read tool. They are only
/// files to look at: never run or opened by anything here.
/// </summary>
public static partial class CodeJobImages
{
    public const string Folder = "images";

    /// <summary>At most this many images go with one prompt (the server sends at most 8).</summary>
    public const int MaxImages = 8;

    /// <summary>One image, as the server scales it down (at most 1568 px, 3 MB); a little room above.</summary>
    public const int MaxImageBytes = 4 * 1024 * 1024;

    /// <summary>All images of one prompt together.</summary>
    public const int MaxTotalBytes = 10 * 1024 * 1024;

    /// <summary>The line before the images' paths in <c>prompt.txt</c>.</summary>
    public const string Heading = "Attached images (open each one with the Read tool):";

    /// <summary>
    /// The images of the command, or none without <c>images</c>; <c>failed</c> with a sentence
    /// when one isn't right: a name that isn't one the server makes, data that isn't base64 of
    /// a PNG, JPEG, WebP or GIF whose type matches its name, too many or too large.
    /// </summary>
    internal static IReadOnlyList<CodeJobImage> Parse(Args args)
    {
        if (!args.Has("images"))
        {
            return [];
        }

        if (args.Node("images") is not JsonArray list)
        {
            throw CommandException.Failed("“images” must be a list.");
        }

        if (list.Count > MaxImages)
        {
            throw CommandException.Failed($"At most {MaxImages} images can go with one prompt.");
        }

        var images = new List<CodeJobImage>();
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        long total = 0;
        foreach (var node in list)
        {
            if (node is not JsonObject item
                || item["name"] is not JsonValue nameValue || !nameValue.TryGetValue<string>(out var name)
                || item["data"] is not JsonValue dataValue || !dataValue.TryGetValue<string>(out var data))
            {
                throw CommandException.Failed("Every image must have a “name” and “data”.");
            }

            if (!NamePattern().IsMatch(name) || !names.Add(name))
            {
                throw CommandException.Failed("An image's name must be like 1-screenshot.png (a number, a dash, letters, digits, dots, dashes or underscores, and .png, .jpg, .webp or .gif), each name once.");
            }

            // Base64 is 4 characters for 3 bytes: refuse a too long text before decoding it.
            if (data.Length > (MaxImageBytes + 2) / 3 * 4)
            {
                throw CommandException.Failed($"The image {name} is larger than {MaxImageBytes / (1024 * 1024)} MB.");
            }

            byte[] bytes;
            try
            {
                bytes = Convert.FromBase64String(data);
            }
            catch (FormatException)
            {
                throw CommandException.Failed($"The image {name} couldn't be read (its data isn't base64).");
            }

            if (bytes.Length > MaxImageBytes)
            {
                throw CommandException.Failed($"The image {name} is larger than {MaxImageBytes / (1024 * 1024)} MB.");
            }

            if (TypeOf(bytes) is not { } type || type != ExtensionOf(name))
            {
                throw CommandException.Failed($"The image {name} isn't the PNG, JPEG, WebP or GIF image its name says.");
            }

            total += bytes.Length;
            if (total > MaxTotalBytes)
            {
                throw CommandException.Failed($"The images are larger than {MaxTotalBytes / (1024 * 1024)} MB together.");
            }

            images.Add(new CodeJobImage(name, bytes));
        }

        return images;
    }

    /// <summary>
    /// Writes the images into <c>&lt;jobFolder&gt;\images\</c> and returns the prompt with their
    /// full paths after it (<see cref="Prompt"/>). Throws <see cref="IOException"/> (or
    /// <see cref="UnauthorizedAccessException"/>) when a file can't be written.
    /// </summary>
    public static string Write(string jobFolder, IReadOnlyList<CodeJobImage> images, string prompt)
    {
        if (images.Count == 0)
        {
            return prompt;
        }

        var folder = Path.Combine(jobFolder, Folder);
        Directory.CreateDirectory(folder);
        var paths = new List<string>();
        foreach (var image in images)
        {
            // The name was checked (NamePattern): no separator, no "..". The full path is
            // checked again all the same, so nothing is ever written outside the folder.
            var path = Path.GetFullPath(Path.Combine(folder, image.Name));
            if (!string.Equals(Path.GetDirectoryName(path), Path.GetFullPath(folder), StringComparison.OrdinalIgnoreCase))
            {
                throw new IOException("An image's name points outside the job folder.");
            }

            File.WriteAllBytes(path, image.Data);
            paths.Add(path);
        }

        return Prompt(prompt, paths);
    }

    /// <summary>
    /// The prompt as Claude Code gets it: the user's text, a blank line, <see cref="Heading"/>,
    /// and one line <c>- &lt;full path&gt;</c> per image.
    /// </summary>
    public static string Prompt(string prompt, IEnumerable<string> paths)
    {
        var text = new StringBuilder(prompt.TrimEnd());
        text.Append("\n\n").Append(Heading);
        foreach (var path in paths)
        {
            text.Append("\n- ").Append(path);
        }

        return text.Append('\n').ToString();
    }

    /// <summary>The image type its first bytes say ("png", "jpg", "gif", "webp"), or null.</summary>
    public static string? TypeOf(ReadOnlySpan<byte> data)
    {
        if (data.StartsWith(PngSignature))
        {
            return "png";
        }

        if (data.Length >= 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF)
        {
            return "jpg";
        }

        if (data.StartsWith("GIF87a"u8) || data.StartsWith("GIF89a"u8))
        {
            return "gif";
        }

        if (data.Length >= 12 && data[..4].SequenceEqual("RIFF"u8) && data[8..12].SequenceEqual("WEBP"u8))
        {
            return "webp";
        }

        return null;
    }

    private static readonly byte[] PngSignature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

    private static string ExtensionOf(string name) => name[(name.LastIndexOf('.') + 1)..].ToLowerInvariant();

    /// <summary>The names the server makes (code_sessions/images.py): "&lt;n&gt;-&lt;stem&gt;.&lt;ext&gt;".</summary>
    [GeneratedRegex(@"^\d{1,2}-[A-Za-z0-9._-]{1,80}\.(png|jpg|webp|gif)\z")]
    private static partial Regex NamePattern();
}
