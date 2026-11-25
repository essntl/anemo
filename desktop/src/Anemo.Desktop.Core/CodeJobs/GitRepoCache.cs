using System.Collections.Concurrent;
using System.Security.Cryptography;
using Anemo.Desktop.Core.Commands;

namespace Anemo.Desktop.Core.CodeJobs;

/// <summary>How long the cache's git runs may take, how stale it may get and how big it may grow.</summary>
public sealed record GitCacheLimits(
    TimeSpan CloneTimeout,
    TimeSpan FetchTimeout,
    TimeSpan FetchAge,
    long RepositoryMaxBytes,
    long TotalMaxBytes);

/// <summary>A repository of the cache, locked for one read; disposing it lets the next one in.</summary>
public sealed class GitCacheLease : IDisposable
{
    private SemaphoreSlim? _lock;

    internal GitCacheLease(string dir, DateTimeOffset? fetchedAt, string? fetchError, SemaphoreSlim held)
    {
        Dir = dir;
        FetchedAt = fetchedAt;
        FetchError = fetchError;
        _lock = held;
    }

    /// <summary>The bare repository's folder.</summary>
    public string Dir { get; }

    /// <summary>When it was last fetched (null: never, which a cache repository never is).</summary>
    public DateTimeOffset? FetchedAt { get; }

    /// <summary>Why this read's fetch didn't work (the read is then from what was there).</summary>
    public string? FetchError { get; }

    public void Dispose() => Interlocked.Exchange(ref _lock, null)?.Release();
}

/// <summary>
/// The remote repositories of <c>code_git_graph</c> and <c>code_git_commit</c> with <c>repo</c>
/// (device-contracts.md §7.6): blobless bare clones in
/// <c>&lt;app data&gt;/git-cache/&lt;owner&gt;/&lt;name&gt;.git</c> (lower case), never in the
/// projects folder. A clone is made in a temporary folder next to its place
/// (<c>.&lt;name&gt;.git.&lt;random&gt;.tmp</c>), fetched there, measured, and only then moved
/// into place, so a half clone is never read. Each repository has a lock: two reads of it
/// never clone or fetch at once, and the cache is never cleaned under a read.
///
/// Two empty files in a repository's folder keep its times, written with the client's clock:
/// <c>anemo-fetched</c> (its last fetch that worked) and <c>anemo-read</c> (its last read, for
/// removing the least recently read ones when the cache is over its size).
/// </summary>
public sealed class GitRepoCache
{
    public const string FetchedFile = "anemo-fetched";
    public const string ReadFile = "anemo-read";

    /// <summary>The fetch of a cache repository, after the options: its branches and tags as the remote has them.</summary>
    public static readonly IReadOnlyList<string> FetchArguments =
        ["fetch", "--prune", "--filter=blob:none", "origin", "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"];

    private readonly ICodeHost _host;
    private readonly TimeProvider _time;
    private readonly string _hooks;
    private readonly GitCacheLimits _limits;
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _locks = new(StringComparer.Ordinal);

    /// <param name="folder">The cache folder (the client's own data folder's <c>git-cache</c>).</param>
    /// <param name="hooksFolder">An empty folder of the client's, for <c>core.hooksPath</c>.</param>
    public GitRepoCache(ICodeHost host, TimeProvider time, string folder, string hooksFolder, GitCacheLimits limits)
    {
        _host = host;
        _time = time;
        Folder = folder;
        _hooks = hooksFolder;
        _limits = limits;
    }

    public string Folder { get; }

    /// <summary>
    /// The repository <paramref name="owner"/>/<paramref name="name"/>, cloned from
    /// <paramref name="url"/> (from the owner's <c>gh repo list</c>) when it isn't in the cache
    /// yet, fetched when <paramref name="fetch"/> or when its last fetch is older than
    /// <see cref="GitCacheLimits.FetchAge"/>, and locked until the lease is disposed.
    /// </summary>
    /// <exception cref="CommandException">
    /// <c>refused</c>: its folder leads out of the cache; <c>unauthenticated</c>: git isn't signed
    /// in; <c>failed</c>: the clone didn't work, took too long or is too large.
    /// </exception>
    public async Task<GitCacheLease> OpenAsync(string git, string owner, string name, string url, bool fetch, CancellationToken ct)
    {
        var repo = $"{owner}/{name}";
        var key = Key(owner, name);
        var ownerDir = Path.Combine(Folder, owner.ToLowerInvariant());
        var dir = Path.Combine(ownerDir, name.ToLowerInvariant() + ".git");
        Directory.CreateDirectory(Folder);
        if (!FolderLinks.IsInsideResolved(Folder, dir))
        {
            throw CommandException.Refused($"The cache folder of {repo} leads out of Anemo Desktop's git cache (a link), so Anemo doesn't read it.");
        }

        var held = _locks.GetOrAdd(key, _ => new SemaphoreSlim(1, 1));
        await held.WaitAsync(ct);
        try
        {
            Directory.CreateDirectory(ownerDir);
            string? fetchError = null;
            if (!Directory.Exists(dir))
            {
                await CloneAsync(git, repo, url, ownerDir, dir, ct);
                Evict(key);
            }
            else if (fetch || Time(dir, FetchedFile) is not { } last || _time.GetUtcNow() - last > _limits.FetchAge)
            {
                fetchError = await RefetchAsync(git, repo, dir, ct);
            }

            Mark(dir, ReadFile);
            return new GitCacheLease(dir, Time(dir, FetchedFile), fetchError, held);
        }
        catch
        {
            held.Release();
            throw;
        }
    }

    /// <summary>Removes every repository of the cache no read is using now; answers how many and the bytes freed.</summary>
    public (int Removed, long Bytes) Clear()
    {
        var removed = 0;
        long bytes = 0;
        foreach (var (key, dir, isRepository) in Entries())
        {
            if (TryDeleteUnlocked(key, dir) is { } size)
            {
                bytes += size;
                removed += isRepository ? 1 : 0;
            }
        }

        foreach (var ownerDir in Directories(Folder))
        {
            TryDeleteIfEmpty(ownerDir);
        }

        return (removed, bytes);
    }

    /// <summary>The bytes of the files in a folder (links aren't followed).</summary>
    public static long Size(string folder)
    {
        var options = new EnumerationOptions { RecurseSubdirectories = true, IgnoreInaccessible = true, AttributesToSkip = FileAttributes.ReparsePoint };
        try
        {
            return new DirectoryInfo(folder).EnumerateFiles("*", options).Sum(f => f.Length);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return 0;
        }
    }

    private static string Key(string owner, string name) => $"{owner.ToLowerInvariant()}/{name.ToLowerInvariant()}";

    private static string TooLarge(string repo) => $"{repo} is too large to read without cloning.";

    /// <summary>Clone and first fetch in a temporary folder, then into place.</summary>
    private async Task CloneAsync(string git, string repo, string url, string ownerDir, string dir, CancellationToken ct)
    {
        var name = Path.GetFileName(dir);
        foreach (var stale in Directories(ownerDir).Where(d => TempOf(Path.GetFileName(d)) == name))
        {
            TryDelete(stale); // left by a clone that was stopped with the app
        }

        var temp = Path.Combine(ownerDir, $".{name}.{RandomNumberGenerator.GetHexString(8, lowercase: true)}.tmp");
        var done = false;
        try
        {
            var clone = await RunAsync(git, ["clone", "--bare", "--filter=blob:none", "--no-tags", "--", url, temp], ownerDir, _limits.CloneTimeout, ct)
                ?? throw CommandException.Failed(TooLarge(repo));
            if (clone.ExitCode != 0 || !Directory.Exists(temp))
            {
                throw Refusal(repo, clone, "cloned");
            }

            var first = await RunAsync(git, FetchArguments, temp, _limits.FetchTimeout, ct)
                ?? throw CommandException.Failed($"Fetching {repo} took longer than {_limits.FetchTimeout.TotalSeconds:0} seconds, so it wasn't read.");
            if (first.ExitCode != 0)
            {
                throw Refusal(repo, first, "fetched");
            }

            if (Size(temp) > _limits.RepositoryMaxBytes)
            {
                throw CommandException.Failed(TooLarge(repo));
            }

            Mark(temp, FetchedFile);
            Directory.Move(temp, dir);
            done = true;
        }
        finally
        {
            if (!done)
            {
                TryDelete(temp);
            }
        }
    }

    /// <summary>The fetch of a repository already in the cache; null when it worked, else the sentence for <c>fetch_error</c>.</summary>
    private async Task<string?> RefetchAsync(string git, string repo, string dir, CancellationToken ct)
    {
        var result = await RunAsync(git, FetchArguments, dir, _limits.FetchTimeout, ct);
        if (result is null)
        {
            return $"The fetch from GitHub took longer than {_limits.FetchTimeout.TotalSeconds:0} seconds, so this is what the cache had before.";
        }

        if (result.ExitCode != 0)
        {
            if (GitFetch.IsSignInRefusal(result.Stderr))
            {
                throw Refusal(repo, result, "fetched");
            }

            return $"The fetch from GitHub failed (exit code {result.ExitCode}), so this is what the cache had before.";
        }

        if (Size(dir) > _limits.RepositoryMaxBytes)
        {
            TryDelete(dir);
            throw CommandException.Failed(TooLarge(repo));
        }

        Mark(dir, FetchedFile);
        return null;
    }

    /// <summary>The failed clone or fetch as an error: <c>unauthenticated</c> when git said it wasn't signed in, else <c>failed</c>. Never git's own text.</summary>
    private static CommandException Refusal(string repo, ToolResult result, string what) =>
        GitFetch.IsSignInRefusal(result.Stderr)
            ? CommandException.Unauthenticated(
                $"git on this computer isn't signed in to GitHub for {repo}, so it couldn't be {what} (gh auth login, then gh auth setup-git).")
            : CommandException.Failed($"git couldn't {(what == "cloned" ? "clone" : "fetch")} {repo} (exit code {result.ExitCode}).");

    /// <summary>The run's result, or null when it took longer than <paramref name="timeout"/> (its process tree is ended then).</summary>
    private async Task<ToolResult?> RunAsync(string git, IReadOnlyList<string> args, string dir, TimeSpan timeout, CancellationToken ct)
    {
        if (!GitFetch.TryMakeEmptyFolder(_hooks))
        {
            throw CommandException.Failed("Anemo Desktop's empty hooks folder can't be made, so nothing is cloned or fetched.");
        }

        try
        {
            return await _host.RunAsync(new ToolRun(git, [.. GitReads.SafeOptions, .. GitFetch.Options(_hooks), .. args], dir, GitReads.Environment), timeout, ct);
        }
        catch (TimeoutException)
        {
            return null;
        }
    }

    /// <summary>After a clone: the least recently read repositories go until the cache is within its size; never <paramref name="keep"/>, never one being read.</summary>
    private void Evict(string keep)
    {
        var repositories = Entries()
            .Where(e => e.IsRepository && e.Key != keep)
            .Select(e => (e.Key, e.Dir, Read: Time(e.Dir, ReadFile) ?? Directory.GetLastWriteTimeUtc(e.Dir)))
            .OrderBy(e => e.Read)
            .ToList();
        var total = Size(Folder);
        foreach (var (key, dir, _) in repositories)
        {
            if (total <= _limits.TotalMaxBytes)
            {
                break;
            }

            if (TryDeleteUnlocked(key, dir) is { } size)
            {
                total -= size;
            }
        }
    }

    /// <summary>
    /// Every repository folder (<c>&lt;owner&gt;/&lt;name&gt;.git</c>) and leftover temporary
    /// clone of the cache, with its lock's key. A folder that leads out of the cache (a link)
    /// is left out, so nothing outside it is ever removed.
    /// </summary>
    private IEnumerable<(string Key, string Dir, bool IsRepository)> Entries()
    {
        foreach (var ownerDir in Directories(Folder))
        {
            var owner = Path.GetFileName(ownerDir);
            foreach (var dir in Directories(ownerDir).Where(d => FolderLinks.IsInsideResolved(Folder, d)))
            {
                var folderName = Path.GetFileName(dir);
                if (TempOf(folderName) is { } temp)
                {
                    yield return ($"{owner}/{temp[..^4]}", dir, false);
                }
                else if (folderName.EndsWith(".git", StringComparison.Ordinal) && !folderName.StartsWith('.'))
                {
                    yield return ($"{owner}/{folderName[..^4]}", dir, true);
                }
            }
        }
    }

    /// <summary><c>name.git</c> for a temporary clone's folder <c>.name.git.&lt;random&gt;.tmp</c>, else null.</summary>
    private static string? TempOf(string folderName)
    {
        if (!folderName.StartsWith('.') || !folderName.EndsWith(".tmp", StringComparison.Ordinal))
        {
            return null;
        }

        var end = folderName.LastIndexOf(".git.", StringComparison.Ordinal);
        return end > 1 ? folderName[1..(end + 4)] : null;
    }

    /// <summary>Deletes the folder unless a read holds its lock; its size, or null when it stayed.</summary>
    private long? TryDeleteUnlocked(string key, string dir)
    {
        var held = _locks.GetOrAdd(key, _ => new SemaphoreSlim(1, 1));
        if (!held.Wait(0))
        {
            return null;
        }

        try
        {
            var size = Size(dir);
            return TryDelete(dir) ? size : null;
        }
        finally
        {
            held.Release();
        }
    }

    private DateTimeOffset? Time(string dir, string file)
    {
        var path = Path.Combine(dir, file);
        return File.Exists(path) ? new DateTimeOffset(File.GetLastWriteTimeUtc(path), TimeSpan.Zero) : null;
    }

    /// <summary>Sets the marker's time to now on the client's clock.</summary>
    private void Mark(string dir, string file)
    {
        var path = Path.Combine(dir, file);
        try
        {
            File.WriteAllBytes(path, []);
            File.SetLastWriteTimeUtc(path, _time.GetUtcNow().UtcDateTime);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // Without it the repository is fetched again next time, or removed sooner.
        }
    }

    private static IEnumerable<string> Directories(string folder)
    {
        try
        {
            return Directory.GetDirectories(folder);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return [];
        }
    }

    /// <summary>Deletes a folder tree; git keeps its objects read-only, which Windows won't delete as they are. Links inside are removed, not followed.</summary>
    private static bool TryDelete(string folder)
    {
        try
        {
            if (!Directory.Exists(folder))
            {
                return true;
            }

            var options = new EnumerationOptions { RecurseSubdirectories = true, IgnoreInaccessible = true, AttributesToSkip = FileAttributes.ReparsePoint };
            foreach (var file in new DirectoryInfo(folder).EnumerateFiles("*", options))
            {
                file.Attributes = FileAttributes.Normal;
            }

            Directory.Delete(folder, recursive: true);
            return true;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    private static void TryDeleteIfEmpty(string folder)
    {
        try
        {
            if (!Directory.EnumerateFileSystemEntries(folder).Any())
            {
                Directory.Delete(folder);
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
    }
}
