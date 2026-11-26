namespace Anemo.Desktop.Core.Updates;

/// <summary>
/// What differs between Windows and macOS: which release file is this computer's, where the
/// download goes, the platform's own checks of it, and the swap's paths. Implemented by the
/// hosts (<c>WindowsUpdatePlatform</c>, <c>MacUpdatePlatform</c>).
/// </summary>
public interface IUpdatePlatform
{
    /// <summary>Why this copy can't update itself (a development build, a folder it can't write), or null.</summary>
    string? Unavailable { get; }

    /// <summary>The release file for this computer, e.g. <c>Anemo-Desktop-win-x64.exe</c>.</summary>
    string AssetName { get; }

    /// <summary>The checksum file that lists it, e.g. <c>SHA256SUMS-desktop.txt</c>.</summary>
    string ChecksumsName { get; }

    /// <summary>Said before installing, when installing has a cost (macOS ad hoc builds lose their permissions), or null.</summary>
    string? Note { get; }

    /// <summary>Where the download is written (on the volume of the running copy, so the swap is a rename).</summary>
    string DownloadPath { get; }

    IUpdateFiles Files { get; }

    IUpdateLauncher Launcher { get; }

    /// <summary>Removes what an earlier run left (a half download, an unused staged copy).</summary>
    void CleanUp();

    /// <summary>
    /// Turns the downloaded file (its SHA-256 already right) into a staged update: on Windows the
    /// exe's version resource and a <c>--self-test</c> run; on macOS unzipping, <c>codesign --verify</c>,
    /// the Team ID compared with the running app's, and a <c>--self-test</c> run.
    /// </summary>
    /// <exception cref="UpdateRefusedException">It must not be installed; the message says why.</exception>
    Task<StagedUpdate> PrepareAsync(string downloaded, AppVersion version, CancellationToken ct);
}

/// <summary>For a client without a host that can update (tests, development).</summary>
public sealed class NoUpdatePlatform : IUpdatePlatform
{
    public static readonly NoUpdatePlatform Instance = new();

    public string? Unavailable => "This copy of Anemo Desktop doesn't update itself.";

    public string AssetName => "";

    public string ChecksumsName => "";

    public string? Note => null;

    public string DownloadPath => "";

    public IUpdateFiles Files => DiskUpdateFiles.Instance;

    public IUpdateLauncher Launcher => throw new InvalidOperationException("no updates here");

    public void CleanUp()
    {
    }

    public Task<StagedUpdate> PrepareAsync(string downloaded, AppVersion version, CancellationToken ct) =>
        throw new UpdateRefusedException(Unavailable!);
}

/// <summary>The launcher of <see cref="NoUpdatePlatform"/>: never used, as nothing is ever staged.</summary>
internal sealed class NoLauncher : IUpdateLauncher
{
    public static readonly NoLauncher Instance = new();

    public IUpdateProcess? Start(string appPath, string? argument) => throw new InvalidOperationException("no updates here");
}
