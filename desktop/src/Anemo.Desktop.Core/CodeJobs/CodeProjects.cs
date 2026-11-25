using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anemo.Desktop.Core.CodeJobs;

/// <summary>A folder in the projects folder; <see cref="Remote"/> is its <c>origin</c> URL.</summary>
public sealed record LocalProject(string Name, string Dir, string? Remote);

/// <summary>A repository of the owner on GitHub.</summary>
public sealed record RemoteProject(string Name, string Url);

/// <summary>The projects folder and its git remotes (code-sessions.md §12.1).</summary>
public static partial class CodeProjects
{
    /// <summary>Names Windows keeps for devices, also with an extension (<c>nul.txt</c> is NUL).</summary>
    private static readonly HashSet<string> DeviceNames = new(
        new[] { "CON", "PRN", "AUX", "NUL" }
            .Concat(Enumerable.Range(1, 9).Select(i => $"COM{i}"))
            .Concat(Enumerable.Range(1, 9).Select(i => $"LPT{i}")),
        StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// A project name (code-sessions.md §12.5): letters, digits, <c>.</c>, <c>_</c>, <c>-</c>,
    /// at most 100; not only dots, not ending with a dot, not a Windows device name.
    /// </summary>
    public static bool IsProjectName(string name) =>
        ProjectPattern().IsMatch(name)
        && name.Trim('.').Length > 0
        && !name.EndsWith('.')
        && !DeviceNames.Contains(name.Split('.')[0]);

    /// <summary>A GitHub user or organisation name.</summary>
    public static bool IsOwner(string owner) => OwnerPattern().IsMatch(owner);

    /// <summary>Every folder in <paramref name="projectsFolder"/>, by name; none when it is missing.</summary>
    public static IReadOnlyList<LocalProject> Local(string projectsFolder)
    {
        string[] folders;
        try
        {
            folders = Directory.GetDirectories(projectsFolder);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return [];
        }

        return folders
            .Select(dir => new LocalProject(Path.GetFileName(dir), dir, OriginUrl(dir)))
            .Where(p => !p.Name.StartsWith('.'))
            .OrderBy(p => p.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    /// <summary>
    /// The <c>url</c> of <c>[remote "origin"]</c> in the folder's git config (also for a
    /// worktree, whose config is in the main repository); null when there is none.
    /// </summary>
    public static string? OriginUrl(string dir)
    {
        try
        {
            var config = ConfigPath(dir);
            if (config is null || !File.Exists(config))
            {
                return null;
            }

            var inOrigin = false;
            foreach (var raw in File.ReadLines(config))
            {
                var line = raw.Trim();
                if (line.StartsWith('['))
                {
                    inOrigin = OriginSection().IsMatch(line);
                    continue;
                }

                if (inOrigin && UrlLine().Match(line) is { Success: true } m)
                {
                    var url = m.Groups[1].Value.Trim().Trim('"');
                    return url.Length == 0 ? null : url;
                }
            }

            return null;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return null;
        }
    }

    /// <summary>
    /// The repository's name in a remote URL: <c>https://github.com/o/anemo.git</c>,
    /// <c>git@github.com:o/anemo.git</c> → <c>anemo</c>; null when there is none.
    /// </summary>
    public static string? RepositoryName(string? url)
    {
        if (string.IsNullOrWhiteSpace(url))
        {
            return null;
        }

        var name = url.Trim().TrimEnd('/');
        var cut = name.LastIndexOfAny(['/', ':', '\\']);
        name = cut < 0 ? name : name[(cut + 1)..];
        if (name.EndsWith(".git", StringComparison.OrdinalIgnoreCase))
        {
            name = name[..^4];
        }

        return name.Length == 0 ? null : name;
    }

    /// <summary>The repositories in <c>gh repo list --json name,url</c>'s output, or null when it doesn't read.</summary>
    public static IReadOnlyList<RemoteProject>? ParseRepoList(string json)
    {
        try
        {
            if (JsonNode.Parse(json) is not JsonArray items)
            {
                return null;
            }

            return items.OfType<JsonObject>()
                .Select(i => (Name: Protocol.Wire.Str(i, "name"), Url: Protocol.Wire.Str(i, "url")))
                .Where(i => i.Name is { Length: > 0 } && i.Url is { Length: > 0 })
                .Select(i => new RemoteProject(i.Name!, i.Url!))
                .ToList();
        }
        catch (Exception e) when (e is JsonException or ArgumentException or InvalidOperationException)
        {
            return null;
        }
    }

    /// <summary>A local folder named <paramref name="project"/>, or whose origin's repository is it.</summary>
    public static bool HasLocal(IEnumerable<LocalProject> local, string project) =>
        local.Any(p => string.Equals(p.Name, project, StringComparison.OrdinalIgnoreCase)
            || string.Equals(RepositoryName(p.Remote), project, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// The folder's own git folder: <c>.git</c>, or for a worktree the folder its <c>.git</c>
    /// file points at (where its HEAD and FETCH_HEAD are); null when there is none. Reads only
    /// the <c>.git</c> file, never runs git.
    /// </summary>
    public static string? GitDir(string dir)
    {
        try
        {
            var git = Path.Combine(dir, ".git");
            if (Directory.Exists(git))
            {
                return git;
            }

            if (!File.Exists(git))
            {
                return null;
            }

            var pointer = File.ReadAllText(git).Trim();
            if (!pointer.StartsWith("gitdir:", StringComparison.Ordinal))
            {
                return null;
            }

            var gitDir = pointer["gitdir:".Length..].Trim();
            return Path.IsPathRooted(gitDir) ? gitDir : Path.GetFullPath(Path.Combine(dir, gitDir));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return null;
        }
    }

    /// <summary>When the folder's FETCH_HEAD was last written (its last fetch), or null when it was never fetched.</summary>
    public static DateTimeOffset? FetchHeadTime(string dir)
    {
        if (GitDir(dir) is not { } gitDir)
        {
            return null;
        }

        try
        {
            var fetchHead = Path.Combine(gitDir, "FETCH_HEAD");
            return File.Exists(fetchHead) ? new DateTimeOffset(File.GetLastWriteTimeUtc(fetchHead), TimeSpan.Zero) : null;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return null;
        }
    }

    private static string? ConfigPath(string dir)
    {
        if (GitDir(dir) is not { } gitDir)
        {
            return null;
        }

        // A worktree's gitdir names the main repository's folder in "commondir".
        var commonFile = Path.Combine(gitDir, "commondir");
        if (File.Exists(commonFile))
        {
            var common = File.ReadAllText(commonFile).Trim();
            gitDir = Path.IsPathRooted(common) ? common : Path.GetFullPath(Path.Combine(gitDir, common));
        }

        return Path.Combine(gitDir, "config");
    }

    [GeneratedRegex(@"^[A-Za-z0-9._-]{1,100}\z")]
    private static partial Regex ProjectPattern();

    [GeneratedRegex(@"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\z")]
    private static partial Regex OwnerPattern();

    [GeneratedRegex(@"^\[\s*remote\s+""origin""\s*\]\z")]
    private static partial Regex OriginSection();

    [GeneratedRegex(@"^url\s*=\s*(.*)\z", RegexOptions.IgnoreCase)]
    private static partial Regex UrlLine();
}
