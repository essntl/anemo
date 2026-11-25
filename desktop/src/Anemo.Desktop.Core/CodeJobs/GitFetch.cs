namespace Anemo.Desktop.Core.CodeJobs;

/// <summary>
/// The git fetches of 1.6.0 (device-contracts.md §7.6): <c>fetch: true</c> on a local checkout,
/// and the clone and fetch of the remote repository cache (<see cref="GitRepoCache"/>). They
/// run with <see cref="GitReads.SafeOptions"/> and <see cref="GitReads.Environment"/>, plus
/// <see cref="Options"/>: no hooks, no <c>ext::</c> or <c>file://</c> transports, no submodules,
/// no automatic maintenance afterwards. A fetch changes only remote-tracking refs and
/// FETCH_HEAD (the cache: its own refs), never a working tree or a local branch.
/// </summary>
public static class GitFetch
{
    /// <summary>The fetch of a local checkout, after the options.</summary>
    public static readonly IReadOnlyList<string> LocalArguments = ["fetch", "--prune", "--all", "--no-recurse-submodules"];

    /// <summary>
    /// What git prints when a clone or fetch was refused for want of a sign-in (it runs with
    /// <c>GIT_TERMINAL_PROMPT=0</c>, so it fails at once instead of asking). "Repository not
    /// found" is among them: GitHub says that to a git that isn't signed in for a private
    /// repository, and a repository of the cache is one gh has just listed, so it is there.
    /// </summary>
    private static readonly string[] SignInPhrases =
    [
        "authentication failed",
        "could not read username",
        "could not read password",
        "terminal prompts disabled",
        "invalid username or password",
        "permission denied (publickey)",
        "repository not found",
        "the requested url returned error: 401",
        "the requested url returned error: 403",
    ];

    /// <summary>In front of a clone or fetch, after <see cref="GitReads.SafeOptions"/>; <paramref name="hooksFolder"/> is an empty folder of the client's.</summary>
    public static IReadOnlyList<string> Options(string hooksFolder) =>
    [
        "-c", "core.hooksPath=" + hooksFolder,
        "-c", "protocol.ext.allow=never",
        "-c", "protocol.file.allow=never",
        "-c", "fetch.recurseSubmodules=false",
        "-c", "maintenance.auto=false",
        "-c", "gc.auto=0",
    ];

    /// <summary>True when a failed clone or fetch's error output says git wasn't signed in. The text itself is never passed on.</summary>
    public static bool IsSignInRefusal(string stderr) =>
        SignInPhrases.Any(p => stderr.Contains(p, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// <c>git fetch --prune --all --no-recurse-submodules</c> in a local checkout; null when it
    /// worked, else the sentence for <c>fetch_error</c> (the graph is answered all the same).
    /// </summary>
    public static async Task<string?> LocalAsync(ICodeHost host, string git, string dir, string? hooksFolder, TimeSpan timeout, CancellationToken ct)
    {
        if (hooksFolder is null || !TryMakeEmptyFolder(hooksFolder))
        {
            return "Anemo Desktop has no folder of its own to fetch with, so this is what the repository had before.";
        }

        ToolResult result;
        try
        {
            result = await host.RunAsync(
                new ToolRun(git, [.. GitReads.SafeOptions, .. Options(hooksFolder), .. LocalArguments], dir, GitReads.Environment), timeout, ct);
        }
        catch (TimeoutException)
        {
            return $"The fetch took longer than {timeout.TotalSeconds:0} seconds, so this is what the repository had before.";
        }

        if (result.ExitCode == 0)
        {
            return null;
        }

        return IsSignInRefusal(result.Stderr)
            ? "git isn't signed in for this repository's remote on this computer, so it wasn't fetched."
            : $"The fetch failed (exit code {result.ExitCode}), so this is what the repository had before.";
    }

    /// <summary>Makes the hooks folder (it stays empty: nothing ever writes into it); false when it can't be made.</summary>
    public static bool TryMakeEmptyFolder(string folder)
    {
        try
        {
            Directory.CreateDirectory(folder);
            return !Directory.EnumerateFileSystemEntries(folder).Any();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return false;
        }
    }
}
