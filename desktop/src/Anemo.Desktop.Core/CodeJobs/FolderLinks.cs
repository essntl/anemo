namespace Anemo.Desktop.Core.CodeJobs;

/// <summary>
/// Whether a folder is still inside another once links are followed: the projects folder for
/// a project's git reads (device-contracts.md §7.5), the git cache for a remote repository
/// (§7.6). A symlink or junction that points elsewhere is not inside.
/// </summary>
public static class FolderLinks
{
    /// <summary>True when <paramref name="dir"/> is below <paramref name="root"/> (not the root itself), both with their links followed.</summary>
    public static bool IsInsideResolved(string root, string dir) => IsInside(Resolved(root), Resolved(dir));

    /// <summary>The folder's full path with every link on the way followed (the folder itself and its parents).</summary>
    public static string Resolved(string folder)
    {
        var full = Path.GetFullPath(folder);
        var parts = new Stack<string>();
        var current = full;
        while (true)
        {
            try
            {
                if (Directory.ResolveLinkTarget(current, returnFinalTarget: true) is { } target)
                {
                    var resolved = Path.GetFullPath(target.FullName);
                    return parts.Aggregate(resolved, Path.Combine);
                }
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                // A link that can't be followed is not a way out; the folder check fails later.
            }

            var parent = Path.GetDirectoryName(current);
            if (parent is null)
            {
                return full;
            }

            parts.Push(Path.GetFileName(current));
            current = parent;
        }
    }

    /// <summary>True when the full path <paramref name="dir"/> is below the full path <paramref name="root"/> (no links followed).</summary>
    public static bool IsInside(string root, string dir)
    {
        var comparison = OperatingSystem.IsWindows() || OperatingSystem.IsMacOS() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        var prefix = Path.TrimEndingDirectorySeparator(root) + Path.DirectorySeparatorChar;
        return dir.StartsWith(prefix, comparison) && dir.Length > prefix.Length;
    }
}
