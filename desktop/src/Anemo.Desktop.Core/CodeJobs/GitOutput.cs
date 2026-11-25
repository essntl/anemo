using System.Globalization;
using System.Text.RegularExpressions;

namespace Anemo.Desktop.Core.CodeJobs;

/// <summary>A branch, local (<c>main</c>) or remote-tracking (<c>origin/main</c>).</summary>
public sealed record GitBranch(string Name, string Commit, bool Remote, string? Upstream, int Ahead, int Behind, bool Current);

public sealed record GitTag(string Name, string Commit);

public sealed record GitCommit(
    string Hash,
    IReadOnlyList<string> Parents,
    string AuthorName,
    string AuthorEmail,
    string Date,
    string Subject);

/// <summary>What <c>git status --porcelain=v2</c> counts: entries with staged or unstaged changes, untracked files, conflicts.</summary>
public sealed record GitStatus(int Staged, int Unstaged, int Untracked, int Conflicted)
{
    public bool Dirty => Staged + Unstaged + Untracked + Conflicted > 0;
}

public sealed record GitRemote(string Name, string Url);

/// <summary>A file a commit changed: its git status letter (A, M, D, R, C, T) and its line counts (null for a binary file).</summary>
public sealed record GitFileChange(string Path, string Status, int? Additions, int? Deletions);

/// <summary>
/// The output of the fixed git commands of <see cref="GitReads"/>, read field by field. Every
/// command is asked for NUL-separated output (<c>-z</c>, <c>%x00</c>, <c>%00</c>), so a branch
/// name, a subject or a path with spaces, tabs or any other character can't shift a field.
/// Output that doesn't read (a record cut short) is left out, never guessed at.
/// </summary>
public static partial class GitOutput
{
    /// <summary>The fields of one <see cref="LogFormat"/> record.</summary>
    private const int LogFields = 6;

    /// <summary>The fields of one <see cref="RefFormat"/> line.</summary>
    private const int RefFields = 6;

    /// <summary><c>git log -z --format=…</c>: hash, parents, author name, author email, author date (ISO), subject.</summary>
    public const string LogFormat = "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%s";

    /// <summary><c>git for-each-ref --format=…</c>: the ref, its object, the commit an annotated tag points at, its upstream, how far ahead and behind, whether it is HEAD.</summary>
    public const string RefFormat = "--format=%(refname)%00%(objectname)%00%(*objectname)%00%(upstream)%00%(upstream:track,nobracket)%00%(HEAD)";

    /// <summary><c>git show -s -z --format=…</c> of one commit: as <see cref="LogFormat"/>, plus the committer date and the body.</summary>
    public const string CommitFormat = "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%s%x00%b";

    /// <summary>
    /// The commits of <c>git log -z</c> with <see cref="LogFormat"/>: each record ends with a NUL
    /// (<c>-z</c>), and its fields are separated by NULs, so every <see cref="LogFields"/> pieces
    /// are one commit. A record cut short at the end is dropped.
    /// </summary>
    public static IReadOnlyList<GitCommit> ParseLog(string output)
    {
        var parts = output.Split('\0');
        var commits = new List<GitCommit>();
        for (var i = 0; i + LogFields <= parts.Length; i += LogFields)
        {
            // Between records git may put a line break; the hash is never empty.
            var hash = parts[i].Trim('\n', '\r');
            if (!IsHash(hash))
            {
                break;
            }

            commits.Add(new GitCommit(
                hash,
                Parents(parts[i + 1]),
                parts[i + 2],
                parts[i + 3],
                parts[i + 4],
                parts[i + 5]));
        }

        return commits;
    }

    /// <summary>The branches and tags of <c>git for-each-ref</c> with <see cref="RefFormat"/> (one line per ref).</summary>
    public static (IReadOnlyList<GitBranch> Branches, IReadOnlyList<GitTag> Tags) ParseRefs(string output)
    {
        var branches = new List<GitBranch>();
        var tags = new List<GitTag>();
        foreach (var line in output.Split('\n'))
        {
            var f = line.TrimEnd('\r').Split('\0');
            if (f.Length != RefFields || !IsHash(f[1]))
            {
                continue;
            }

            var (refName, objectName, peeled, upstream, track, head) = (f[0], f[1], f[2], f[3], f[4], f[5]);
            if (refName.StartsWith("refs/tags/", StringComparison.Ordinal))
            {
                tags.Add(new GitTag(refName["refs/tags/".Length..], IsHash(peeled) ? peeled : objectName));
                continue;
            }

            var remote = refName.StartsWith("refs/remotes/", StringComparison.Ordinal);
            if (!remote && !refName.StartsWith("refs/heads/", StringComparison.Ordinal))
            {
                continue;
            }

            var name = ShortName(refName);
            if (remote && name.EndsWith("/HEAD", StringComparison.Ordinal))
            {
                continue; // origin/HEAD only says which branch the remote's default is
            }

            var (ahead, behind) = Track(track);
            branches.Add(new GitBranch(
                name,
                objectName,
                remote,
                upstream.Length == 0 ? null : ShortName(upstream),
                ahead,
                behind,
                head == "*"));
        }

        return (branches, tags);
    }

    /// <summary>
    /// What <c>git status --porcelain=v2 -z</c> lists: <c>1 XY …</c> (changed), <c>2 XY …</c>
    /// (renamed or copied; its original path follows as an entry of its own), <c>u XY …</c>
    /// (a conflict), <c>? path</c> (untracked). X is the staged state, Y the unstaged one,
    /// <c>.</c> meaning unchanged.
    /// </summary>
    public static GitStatus ParseStatus(string output)
    {
        int staged = 0, unstaged = 0, untracked = 0, conflicted = 0;
        var entries = output.Split('\0');
        for (var i = 0; i < entries.Length; i++)
        {
            var entry = entries[i].TrimStart('\n', '\r');
            if (entry.Length < 2)
            {
                continue;
            }

            switch (entry[0])
            {
                case '1' or '2' when entry.Length >= 4 && entry[1] == ' ':
                    if (entry[2] != '.')
                    {
                        staged++;
                    }

                    if (entry[3] != '.')
                    {
                        unstaged++;
                    }

                    if (entry[0] == '2')
                    {
                        i++; // the original path
                    }

                    break;
                case 'u' when entry[1] == ' ':
                    conflicted++;
                    break;
                case '?' when entry[1] == ' ':
                    untracked++;
                    break;
            }
        }

        return new GitStatus(staged, unstaged, untracked, conflicted);
    }

    /// <summary>The fetch URL of each remote in <c>git remote -v</c> (<c>name\turl (fetch)</c>), credentials removed.</summary>
    public static IReadOnlyList<GitRemote> ParseRemotes(string output)
    {
        var remotes = new List<GitRemote>();
        foreach (var raw in output.Split('\n'))
        {
            var line = raw.TrimEnd('\r');
            if (!line.EndsWith(" (fetch)", StringComparison.Ordinal))
            {
                continue;
            }

            var tab = line.IndexOf('\t');
            if (tab <= 0)
            {
                continue;
            }

            var name = line[..tab];
            var url = line[(tab + 1)..^" (fetch)".Length];
            if (remotes.All(r => r.Name != name))
            {
                remotes.Add(new GitRemote(name, WithoutCredentials(url)));
            }
        }

        return remotes;
    }

    /// <summary>
    /// One commit of <c>git show -s -z</c> with <see cref="CommitFormat"/>: the fields of
    /// <see cref="GitCommit"/>, the committer date and the body; null when it doesn't read.
    /// </summary>
    public static (GitCommit Commit, string CommitterDate, string Body)? ParseCommit(string output)
    {
        var f = output.Split('\0');
        if (f.Length < 8 || !IsHash(f[0].Trim('\n', '\r')))
        {
            return null;
        }

        var commit = new GitCommit(f[0].Trim('\n', '\r'), Parents(f[1]), f[2], f[3], f[4], f[6]);
        return (commit, f[5], f[7].TrimEnd('\n', '\r'));
    }

    /// <summary>
    /// The files of <c>git diff-tree -r -z --numstat</c> joined with <c>--name-status</c> (both
    /// with <c>-M</c>): numstat gives <c>added\tdeleted\tpath\0</c>, or for a rename
    /// <c>added\tdeleted\t\0old\0new\0</c> (<c>-</c> for a binary file); name-status gives
    /// <c>M\0path\0</c>, or <c>R100\0old\0new\0</c>.
    /// </summary>
    public static IReadOnlyList<GitFileChange> ParseFiles(string numstat, string nameStatus)
    {
        var statuses = new Dictionary<string, string>(StringComparer.Ordinal);
        var ns = Tokens(nameStatus);
        for (var i = 0; i + 1 < ns.Count; i += 2)
        {
            var letter = ns[i][..1];
            if (letter is "R" or "C" && i + 2 < ns.Count)
            {
                statuses[ns[i + 2]] = letter;
                i++;
            }
            else
            {
                statuses[ns[i + 1]] = letter;
            }
        }

        var files = new List<GitFileChange>();
        var nums = Tokens(numstat);
        for (var i = 0; i < nums.Count; i++)
        {
            var f = nums[i].Split('\t');
            if (f.Length != 3)
            {
                continue;
            }

            var path = f[2];
            if (path.Length == 0)
            {
                if (i + 2 >= nums.Count)
                {
                    break;
                }

                path = nums[i + 2]; // a rename: the old path, then the new one
                i += 2;
            }

            files.Add(new GitFileChange(path, statuses.GetValueOrDefault(path, "M"), Count(f[0]), Count(f[1])));
        }

        return files;
    }

    /// <summary>
    /// The files of <c>git diff-tree -r -z --no-renames --name-status</c> alone (a bare cache
    /// repository, which has no file contents to count lines in): <c>M path </c>, line counts null.
    /// </summary>
    public static IReadOnlyList<GitFileChange> ParseNameStatus(string nameStatus)
    {
        var files = new List<GitFileChange>();
        var ns = Tokens(nameStatus);
        for (var i = 0; i + 1 < ns.Count; i += 2)
        {
            var letter = ns[i][..1];
            if (letter is "R" or "C" && i + 2 < ns.Count)
            {
                i++; // not asked for, but a rename names its old path first
            }

            files.Add(new GitFileChange(ns[i + 1], letter, null, null));
        }

        return files;
    }

    /// <summary>A full or abbreviated commit hash, as the server sends one: 7 to 40 lower-case hex digits.</summary>
    public static bool IsCommitRef(string value) => CommitRefPattern().IsMatch(value);

    /// <summary>An http(s) URL without the <c>user:token@</c> some clones keep in it; any other URL as it is.</summary>
    public static string WithoutCredentials(string url)
    {
        var scheme = url.IndexOf("://", StringComparison.Ordinal);
        if (scheme < 0 || url[..scheme].ToLowerInvariant() is not ("http" or "https"))
        {
            return url;
        }

        var start = scheme + 3;
        var end = url.IndexOf('/', start);
        var at = url.LastIndexOf('@', end < 0 ? url.Length - 1 : end - 1, (end < 0 ? url.Length : end) - start);
        return at < 0 ? url : url[..start] + url[(at + 1)..];
    }

    /// <summary><c>refs/heads/main</c> → <c>main</c>; <c>refs/remotes/origin/main</c> → <c>origin/main</c>.</summary>
    private static string ShortName(string refName)
    {
        foreach (var prefix in new[] { "refs/heads/", "refs/remotes/" })
        {
            if (refName.StartsWith(prefix, StringComparison.Ordinal))
            {
                return refName[prefix.Length..];
            }
        }

        return refName;
    }

    /// <summary><c>ahead 2, behind 1</c>, <c>ahead 2</c>, <c>behind 1</c>, <c>gone</c> or nothing (git runs with LC_ALL=C).</summary>
    private static (int Ahead, int Behind) Track(string track)
    {
        int Number(string word)
        {
            var m = Regex.Match(track, word + @" (\d+)");
            return m.Success && int.TryParse(m.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var n) ? n : 0;
        }

        return (Number("ahead"), Number("behind"));
    }

    private static IReadOnlyList<string> Parents(string field) =>
        field.Split(' ', StringSplitOptions.RemoveEmptyEntries).Where(IsHash).ToList();

    private static List<string> Tokens(string output) =>
        output.Split('\0').Select(t => t.TrimStart('\n', '\r')).Where(t => t.Length > 0).ToList();

    private static int? Count(string value) =>
        int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var n) ? n : null;

    private static bool IsHash(string value) => HashPattern().IsMatch(value);

    [GeneratedRegex(@"^[0-9a-f]{40}([0-9a-f]{24})?\z")]
    private static partial Regex HashPattern();

    [GeneratedRegex(@"^[0-9a-f]{7,40}\z")]
    private static partial Regex CommitRefPattern();
}
