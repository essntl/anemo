using System.Globalization;
using System.Text.RegularExpressions;

namespace Anemo.Desktop.Core.Updates;

/// <summary>
/// A stable release version, <c>major.minor.patch</c> (what <c>Directory.Build.props</c> and the
/// <c>desktop-v</c> tags hold). Anything else (a suffix such as <c>-beta.1</c>, a fourth number,
/// leading zeros) doesn't parse, so a pre-release tag can never be picked as an update.
/// </summary>
public readonly partial record struct AppVersion(int Major, int Minor, int Patch) : IComparable<AppVersion>
{
    /// <summary>The prefix of Anemo Desktop's release tags (release.yml, auto-release.yml).</summary>
    public const string TagPrefix = "desktop-v";

    public static AppVersion? Parse(string? text)
    {
        var match = text is null ? null : Strict().Match(text);
        if (match is null || !match.Success)
        {
            return null;
        }

        return int.TryParse(match.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var major)
            && int.TryParse(match.Groups[2].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var minor)
            && int.TryParse(match.Groups[3].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var patch)
                ? new AppVersion(major, minor, patch)
                : null;
    }

    /// <summary>The version in a tag such as <c>desktop-v1.8.0</c>; null for any other tag (<c>voice-v…</c>, <c>v…</c>).</summary>
    public static AppVersion? FromTag(string? tag) =>
        tag is not null && tag.StartsWith(TagPrefix, StringComparison.Ordinal) ? Parse(tag[TagPrefix.Length..]) : null;

    public string Tag => TagPrefix + this;

    /// <summary>
    /// Whether an exe's <c>ProductVersion</c> is this version: exactly, or with the build metadata
    /// .NET appends (<c>1.8.1+3f2a…</c>). Not a prefix: <c>1.8.10</c> isn't <c>1.8.1</c>.
    /// </summary>
    public bool IsProductVersion(string? productVersion) =>
        productVersion is not null
        && (productVersion == ToString() || productVersion.StartsWith(ToString() + "+", StringComparison.Ordinal));

    public int CompareTo(AppVersion other) =>
        Major != other.Major ? Major.CompareTo(other.Major)
        : Minor != other.Minor ? Minor.CompareTo(other.Minor)
        : Patch.CompareTo(other.Patch);

    public static bool operator >(AppVersion a, AppVersion b) => a.CompareTo(b) > 0;

    public static bool operator <(AppVersion a, AppVersion b) => a.CompareTo(b) < 0;

    public static bool operator >=(AppVersion a, AppVersion b) => a.CompareTo(b) >= 0;

    public static bool operator <=(AppVersion a, AppVersion b) => a.CompareTo(b) <= 0;

    public override string ToString() => $"{Major}.{Minor}.{Patch}";

    // At most 9 digits each (fits an int); no leading zeros, as semver says. \z, not $: $ also
    // matches before a final newline.
    [GeneratedRegex(@"^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\z", RegexOptions.CultureInvariant)]
    private static partial Regex Strict();
}
