using System.Text.RegularExpressions;

namespace Anemo.Desktop.Core.CodeJobs;

/// <summary>
/// A repository on github.com named <c>owner/name</c> (device-contracts.md §7.6): the
/// <c>repo</c> field of <c>code_git_graph</c> and <c>code_git_commit</c>, and the repository a
/// local checkout's <c>origin</c> points at.
/// </summary>
public static partial class GitHubRepo
{
    /// <summary>
    /// <c>owner/name</c> as the server may send it: a GitHub owner, then a name of letters,
    /// digits, <c>.</c>, <c>_</c> and <c>-</c> that isn't <c>.</c> or <c>..</c> and doesn't end in <c>.git</c>.
    /// </summary>
    public static bool IsRepo(string value)
    {
        if (!RepoPattern().IsMatch(value))
        {
            return false;
        }

        var name = value[(value.IndexOf('/') + 1)..];
        return name is not ("." or "..") && !name.EndsWith(".git", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// <c>owner/name</c> of a github.com URL (<c>https://github.com/o/n.git</c>,
    /// <c>git@github.com:o/n.git</c>, <c>ssh://git@github.com/o/n</c>); null for any other URL.
    /// </summary>
    public static string? FromUrl(string? url)
    {
        if (string.IsNullOrWhiteSpace(url))
        {
            return null;
        }

        var match = UrlPattern().Match(url.Trim());
        if (!match.Success)
        {
            return null;
        }

        var repo = match.Groups["owner"].Value + "/" + match.Groups["name"].Value;
        return IsRepo(repo) ? repo : null;
    }

    [GeneratedRegex(@"^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}\z")]
    private static partial Regex RepoPattern();

    [GeneratedRegex(
        @"^(?:https?://(?:[^@/]+@)?github\.com/|ssh://git@github\.com(?::22)?/|git@github\.com:)(?<owner>[^/]+)/(?<name>[^/]+?)(?:\.git)?/?\z",
        RegexOptions.IgnoreCase)]
    private static partial Regex UrlPattern();
}
