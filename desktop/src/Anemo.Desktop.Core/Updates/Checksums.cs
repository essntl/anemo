using System.Text;

namespace Anemo.Desktop.Core.Updates;

/// <summary>
/// The release's <c>SHA256SUMS-desktop*.txt</c>, as <c>sha256sum</c> and <c>shasum -a 256</c>
/// write it: one <c>&lt;64 hex digits&gt;  &lt;name&gt;</c> per line, or <c>&lt;hex&gt; *&lt;name&gt;</c> in
/// binary mode (Git Bash's sha256sum on the Windows runner writes that).
/// </summary>
public static class Checksums
{
    /// <summary>The file is a few lines; anything bigger isn't one.</summary>
    public const int MaxBytes = 64 * 1024;

    /// <summary>
    /// The hashes by file name (hex, lower case). Lines that don't have the shape are skipped;
    /// a name listed twice with different hashes is ambiguous and makes the whole file unusable.
    /// </summary>
    /// <exception cref="UpdateRefusedException">The same name with two hashes.</exception>
    public static IReadOnlyDictionary<string, string> Parse(string text)
    {
        var hashes = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var raw in text.Split('\n'))
        {
            var line = raw.TrimEnd('\r');
            if (line.Length < 67 || line[64] != ' ' || (line[65] != ' ' && line[65] != '*') || !IsHex(line.AsSpan(0, 64)))
            {
                continue;
            }

            var name = line[66..];
            var hash = line[..64].ToLowerInvariant();
            if (hashes.TryGetValue(name, out var other) && other != hash)
            {
                throw new UpdateRefusedException($"The checksum file lists {name} twice with different hashes.");
            }

            hashes[name] = hash;
        }

        return hashes;
    }

    /// <summary>The expected SHA-256 of <paramref name="asset"/>.</summary>
    /// <exception cref="UpdateRefusedException">The file doesn't list it.</exception>
    public static string For(byte[] file, string asset)
    {
        var hashes = Parse(Encoding.UTF8.GetString(file));
        return hashes.TryGetValue(asset, out var hash)
            ? hash
            : throw new UpdateRefusedException($"The release's checksum file doesn't list {asset}.");
    }

    /// <summary>Compares two hex hashes in constant time (they aren't secret; it costs nothing).</summary>
    public static bool Same(string expected, byte[] actual) =>
        System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(
            Encoding.ASCII.GetBytes(expected.ToLowerInvariant()),
            Encoding.ASCII.GetBytes(Convert.ToHexString(actual).ToLowerInvariant()));

    private static bool IsHex(ReadOnlySpan<char> text)
    {
        foreach (var c in text)
        {
            if (!char.IsAsciiHexDigit(c))
            {
                return false;
            }
        }

        return true;
    }
}

/// <summary>An update that must not be installed; the message is a sentence for the user.</summary>
public sealed class UpdateRefusedException(string message) : Exception(message);
