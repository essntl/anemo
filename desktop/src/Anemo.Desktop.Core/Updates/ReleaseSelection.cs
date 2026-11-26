using System.Text.Json;

namespace Anemo.Desktop.Core.Updates;

/// <summary>A release that is newer than the running client and has this computer's files.</summary>
public sealed record UpdateCandidate(AppVersion Version, string Tag, string Asset, string Checksums, bool HasSignature);

/// <summary>
/// Picks the update from the GitHub Releases API's list (<c>GET /repos/{repo}/releases</c>):
/// the newest release that is not a draft, not a pre-release, has a <c>desktop-v&lt;x.y.z&gt;</c> tag
/// with a version greater than the running one, and lists both this computer's file and its
/// checksum file. Voice (<c>voice-v…</c>) and server (<c>v…</c>) releases share the list and are skipped.
/// </summary>
public static class ReleaseSelection
{
    /// <returns>The candidate, or null when nothing newer is there.</returns>
    /// <exception cref="UpdateRefusedException">The answer isn't a list of releases.</exception>
    public static UpdateCandidate? Pick(string releasesJson, AppVersion current, string asset, string checksums)
    {
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(releasesJson);
        }
        catch (JsonException)
        {
            throw new UpdateRefusedException("GitHub's list of releases couldn't be read.");
        }

        using (document)
        {
            if (document.RootElement.ValueKind != JsonValueKind.Array)
            {
                throw new UpdateRefusedException("GitHub's list of releases couldn't be read.");
            }

            UpdateCandidate? best = null;
            foreach (var release in document.RootElement.EnumerateArray())
            {
                if (release.ValueKind != JsonValueKind.Object || IsTrue(release, "draft") || IsTrue(release, "prerelease"))
                {
                    continue;
                }

                var tag = release.TryGetProperty("tag_name", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null;
                if (AppVersion.FromTag(tag) is not { } version || version <= current || (best is not null && version <= best.Version))
                {
                    continue;
                }

                var names = AssetNames(release);
                if (names.Contains(asset) && names.Contains(checksums))
                {
                    best = new UpdateCandidate(version, tag!, asset, checksums, names.Contains(checksums + UpdateSignature.Suffix));
                }
            }

            return best;
        }
    }

    private static bool IsTrue(JsonElement release, string name) =>
        release.TryGetProperty(name, out var value) && value.ValueKind != JsonValueKind.False;

    private static HashSet<string> AssetNames(JsonElement release)
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        if (release.TryGetProperty("assets", out var assets) && assets.ValueKind == JsonValueKind.Array)
        {
            foreach (var a in assets.EnumerateArray())
            {
                if (a.ValueKind == JsonValueKind.Object && a.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String)
                {
                    names.Add(n.GetString()!);
                }
            }
        }

        return names;
    }
}
