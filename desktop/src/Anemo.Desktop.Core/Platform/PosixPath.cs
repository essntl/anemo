namespace Anemo.Desktop.Core.Platform;

/// <summary>
/// Finding programs on macOS (docs/specs/09-desktop-macos.md D5, D6). An app started from
/// Finder gets only <c>/usr/bin:/bin:/usr/sbin:/sbin</c> as its PATH, so Homebrew's and Claude
/// Code's folders are added. Only absolute folders count: a relative PATH entry (<c>.</c>, an
/// empty one) would find a program in whatever folder is current, e.g. a cloned repository.
/// </summary>
public static class PosixPath
{
    /// <summary>
    /// The PATH for the shell and for Claude Code jobs: the user's own tool folders first
    /// (Claude Code's installers, Homebrew), then what the app got, then <c>/etc/paths</c>; each
    /// folder once, relative ones left out.
    /// </summary>
    public static string Augmented(string? current, string home, IEnumerable<string> etcPaths)
    {
        var home0 = home.TrimEnd('/');
        var first = new[]
        {
            home0 + "/.local/bin",
            home0 + "/.claude/local",
            "/opt/homebrew/bin",
            "/opt/homebrew/sbin",
            "/usr/local/bin",
        };
        var all = first
            .Concat((current ?? "").Split(':'))
            .Concat(etcPaths)
            .Concat(["/usr/bin", "/bin", "/usr/sbin", "/sbin"])
            .Select(p => p.Trim())
            .Where(p => p.StartsWith('/'))
            .Distinct(StringComparer.Ordinal);
        return string.Join(':', all);
    }

    /// <summary>
    /// The full path of <paramref name="program"/> (a bare name) in the first absolute folder of
    /// <paramref name="path"/> that has it as an executable file, or null.
    /// </summary>
    public static string? Find(string program, string path, Func<string, bool> isExecutable)
    {
        if (program.Length == 0 || program.Contains('/') || program is "." or "..")
        {
            return null;
        }

        foreach (var dir in path.Split(':'))
        {
            if (!dir.StartsWith('/'))
            {
                continue;
            }

            var candidate = dir.TrimEnd('/') + "/" + program;
            if (isExecutable(candidate))
            {
                return candidate;
            }
        }

        return null;
    }
}
