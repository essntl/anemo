namespace Anemo.Desktop.Core.Updates;

/// <summary>
/// Where the swap moves things. On Windows each is an exe beside the running one; on macOS an
/// <c>.app</c> bundle (a folder) beside the running bundle. All three are on one volume, so every
/// move is a rename.
/// </summary>
/// <param name="Current">What runs now, and where the new version goes (<c>Anemo Desktop.exe</c>, <c>/Applications/Anemo Desktop.app</c>).</param>
/// <param name="Staged">The downloaded, checked new version (<c>Anemo Desktop.new.exe</c>, <c>.Anemo Desktop.update/Anemo Desktop.app</c>).</param>
/// <param name="Previous">Where the old version is kept until the next update (<c>Anemo Desktop.old.exe</c>, <c>.Anemo Desktop.old.app</c>).</param>
public sealed record UpdatePaths(string Current, string Staged, string Previous);

/// <summary>A downloaded update that passed every check and waits to be swapped in.</summary>
public sealed record StagedUpdate(AppVersion Version, UpdatePaths Paths);

/// <summary>The few file operations the swap needs, so the tests can use a fake file system.</summary>
public interface IUpdateFiles
{
    bool Exists(string path);

    /// <summary>Renames a file or a folder (an app bundle). Fails if the target exists.</summary>
    void Move(string from, string to);

    /// <summary>Deletes a file, or a folder with everything in it; nothing when it isn't there.</summary>
    void Delete(string path);

    string? ReadText(string path);

    void WriteText(string path, string text);
}

/// <summary>A started copy of the app, as far as the swap's watch needs it.</summary>
public interface IUpdateProcess
{
    bool HasExited { get; }

    void Kill();
}

/// <summary>Starts the app at a path (on macOS through LaunchServices, so it is its own app).</summary>
public interface IUpdateLauncher
{
    /// <returns>The process, or null when the platform can't follow it (the started-file still tells).</returns>
    IUpdateProcess? Start(string appPath, string? argument);
}

/// <summary>What happened to an install.</summary>
public enum InstallOutcome
{
    /// <summary>The new version is in place (and, for a restart, started and said so).</summary>
    Installed,

    /// <summary>Nothing changed: the swap couldn't start; the old version is where it was.</summary>
    NotInstalled,

    /// <summary>The new version was swapped in but didn't start; the old one is back and was started again.</summary>
    RolledBack,

    /// <summary>The swap failed halfway and the old version couldn't be put back: the log says where it is.</summary>
    Broken,
}

/// <summary>
/// Swaps the new version in, in the process that is quitting (docs/specs/23-desktop-auto-update.md
/// "The swap"). Three renames, each undone if the next fails:
/// <list type="number">
/// <item>the previous update's backup is deleted (<c>Previous</c>);</item>
/// <item>the running version is renamed to <c>Previous</c> (Windows allows renaming a running exe, macOS a running bundle);</item>
/// <item>the staged version is renamed to <c>Current</c>; if that fails, step 2 is undone.</item>
/// </list>
/// For "Restart to update" the new version is then started with <c>--updated</c> and must write
/// the started-file within <see cref="StartWatch"/>; if it exits or stays silent, it is ended,
/// the old version is put back and started again, and the version is remembered as failed so it
/// isn't downloaded again by itself.
/// </summary>
public sealed class UpdateInstaller
{
    /// <summary>The argument the restarted copy gets: it waits for the old one to let go, then writes the started-file.</summary>
    public const string UpdatedArgument = "--updated";

    /// <summary>The argument that makes a copy print its version and exit (the check before the swap).</summary>
    public const string SelfTestArgument = "--self-test";

    private readonly IUpdateFiles _files;
    private readonly IUpdateLauncher _launcher;
    private readonly Storage.IDiagnosticLog _log;
    private readonly string _folder;

    /// <param name="updatesFolder">Anemo Desktop's <c>updates</c> folder (beside settings.json): the started-file and the failed-file.</param>
    public UpdateInstaller(IUpdateFiles files, IUpdateLauncher launcher, Storage.IDiagnosticLog log, string updatesFolder)
    {
        _files = files;
        _launcher = launcher;
        _log = log;
        _folder = updatesFolder;
    }

    /// <summary>How long a restarted copy has to say it started.</summary>
    public TimeSpan StartWatch { get; init; } = TimeSpan.FromSeconds(45);

    /// <summary>How often the watch looks.</summary>
    public TimeSpan WatchStep { get; init; } = TimeSpan.FromMilliseconds(250);

    /// <summary>Tries to remove a just-ended copy this many times (Windows keeps an exe locked for a moment).</summary>
    public int DeleteAttempts { get; init; } = 8;

    public string StartedFile => Path.Combine(_folder, "started");

    public string FailedFile => Path.Combine(_folder, "failed");

    /// <summary>Swaps the update in without starting it: "install when I quit". The next start runs the new version.</summary>
    public InstallOutcome InstallOnQuit(StagedUpdate update) => Swap(update);

    /// <summary>Swaps the update in, starts it and watches that it starts; puts the old one back if not.</summary>
    public async Task<InstallOutcome> InstallAndRestartAsync(StagedUpdate update, CancellationToken ct = default)
    {
        Delete(StartedFile);
        var swapped = Swap(update);
        if (swapped != InstallOutcome.Installed)
        {
            if (swapped == InstallOutcome.NotInstalled)
            {
                _launcher.Start(update.Paths.Current, null); // the old one again, so the computer isn't left without the client
            }
            else
            {
                StartPrevious(update);
            }

            return swapped;
        }

        IUpdateProcess? process = null;
        try
        {
            process = _launcher.Start(update.Paths.Current, UpdatedArgument);
        }
        catch (Exception e)
        {
            _log.Info($"update {update.Version}: the new version didn't start: {e.GetType().Name}");
        }

        var started = await WatchAsync(update.Version, process, ct);
        if (started)
        {
            _log.Info($"update {update.Version}: installed and started");
            return InstallOutcome.Installed;
        }

        _log.Info($"update {update.Version}: the new version didn't start; going back");
        try
        {
            if (process is { HasExited: false })
            {
                process.Kill();
            }
        }
        catch (Exception e)
        {
            _log.Info($"update {update.Version}: couldn't end the new version: {e.GetType().Name}");
        }

        var back = RollBack(update);
        RememberFailed(update.Version);
        if (back)
        {
            _launcher.Start(update.Paths.Current, null);
            return InstallOutcome.RolledBack;
        }

        StartPrevious(update);
        return InstallOutcome.Broken;
    }

    /// <summary>
    /// The old version from where it was kept, when it couldn't be put back in its place: the
    /// computer isn't left without the client, and the log says how to rename it back.
    /// </summary>
    private void StartPrevious(StagedUpdate update)
    {
        if (!_files.Exists(update.Paths.Previous))
        {
            return;
        }

        try
        {
            _launcher.Start(update.Paths.Previous, null);
        }
        catch (Exception e)
        {
            _log.Info($"update {update.Version}: the old version didn't start from {update.Paths.Previous}: {e.GetType().Name}");
        }
    }

    /// <summary>The version whose install failed last, if any: the updater doesn't download it again by itself.</summary>
    public AppVersion? FailedVersion() => AppVersion.Parse(_files.ReadText(FailedFile)?.Trim());

    /// <summary>The restarted copy says it is up (with <see cref="UpdatedArgument"/>).</summary>
    public void ReportStarted(AppVersion version)
    {
        try
        {
            _files.WriteText(StartedFile, version.ToString());
            Delete(FailedFile);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            _log.Info($"update: started-file not written: {e.GetType().Name}");
        }
    }

    /// <summary>The three renames (see the class comment).</summary>
    public InstallOutcome Swap(StagedUpdate update)
    {
        var p = update.Paths;
        if (!_files.Exists(p.Staged))
        {
            _log.Info($"update {update.Version}: the staged version is gone; not installed");
            return InstallOutcome.NotInstalled;
        }

        try
        {
            _files.Delete(p.Previous);
            _files.Move(p.Current, p.Previous);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            _log.Info($"update {update.Version}: the running version couldn't be moved aside: {e.GetType().Name}; not installed");
            return InstallOutcome.NotInstalled;
        }

        try
        {
            _files.Move(p.Staged, p.Current);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            _log.Info($"update {update.Version}: the new version couldn't be moved in: {e.GetType().Name}; putting the old one back");
            try
            {
                _files.Move(p.Previous, p.Current);
                return InstallOutcome.NotInstalled;
            }
            catch (Exception again) when (again is IOException or UnauthorizedAccessException)
            {
                _log.Info($"update {update.Version}: BROKEN: the old version is at {p.Previous} ({again.GetType().Name}); rename it back to {p.Current}");
                return InstallOutcome.Broken;
            }
        }

        _log.Info($"update {update.Version}: swapped in (the old version is kept at {Path.GetFileName(p.Previous)})");
        return InstallOutcome.Installed;
    }

    /// <summary>Puts <c>Previous</c> back as <c>Current</c>, removing the new version that didn't start.</summary>
    public bool RollBack(StagedUpdate update)
    {
        var p = update.Paths;
        if (!_files.Exists(p.Previous))
        {
            _log.Info($"update {update.Version}: no previous version to go back to");
            return false;
        }

        for (var attempt = 1; ; attempt++)
        {
            try
            {
                _files.Delete(p.Current);
                _files.Move(p.Previous, p.Current);
                _log.Info($"update {update.Version}: the previous version is back");
                return true;
            }
            catch (Exception e) when ((e is IOException or UnauthorizedAccessException) && attempt < DeleteAttempts)
            {
                Thread.Sleep(WatchStep);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                _log.Info($"update {update.Version}: BROKEN: couldn't go back ({e.GetType().Name}); the old version is at {p.Previous}");
                return false;
            }
        }
    }

    private async Task<bool> WatchAsync(AppVersion version, IUpdateProcess? process, CancellationToken ct)
    {
        var until = DateTimeOffset.UtcNow + StartWatch;
        while (DateTimeOffset.UtcNow < until)
        {
            if (_files.ReadText(StartedFile)?.Trim() == version.ToString())
            {
                return true;
            }

            if (process is { HasExited: true })
            {
                // One last look: it may have written the file and then quit (e.g. "already running").
                return _files.ReadText(StartedFile)?.Trim() == version.ToString();
            }

            await Task.Delay(WatchStep, ct);
        }

        return false;
    }

    private void RememberFailed(AppVersion version)
    {
        try
        {
            _files.WriteText(FailedFile, version.ToString());
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            _log.Info($"update: failed-file not written: {e.GetType().Name}");
        }
    }

    private void Delete(string path)
    {
        try
        {
            _files.Delete(path);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            _log.Info($"update: {Path.GetFileName(path)} not deleted: {e.GetType().Name}");
        }
    }
}

/// <summary>The real file system (files and app bundles alike).</summary>
public sealed class DiskUpdateFiles : IUpdateFiles
{
    public static readonly DiskUpdateFiles Instance = new();

    public bool Exists(string path) => File.Exists(path) || Directory.Exists(path);

    public void Move(string from, string to)
    {
        if (Directory.Exists(from))
        {
            Directory.Move(from, to);
        }
        else
        {
            File.Move(from, to, overwrite: false);
        }
    }

    public void Delete(string path)
    {
        if (Directory.Exists(path))
        {
            Directory.Delete(path, recursive: true);
        }
        else if (File.Exists(path))
        {
            File.Delete(path);
        }
    }

    public string? ReadText(string path)
    {
        try
        {
            return File.ReadAllText(path);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null; // not there (yet), or being written: the watch looks again
        }
    }

    public void WriteText(string path, string text)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, text);
    }
}
