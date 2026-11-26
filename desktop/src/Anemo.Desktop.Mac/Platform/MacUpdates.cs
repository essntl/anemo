using System.Diagnostics;
using System.Runtime.InteropServices;
using Anemo.Desktop.Core.Updates;

namespace Anemo.Desktop.Mac.Platform;

/// <summary>
/// Updates of the <c>.app</c> bundle (docs/specs/23-desktop-auto-update.md, "macOS"): the zip is
/// downloaded into Anemo Desktop's data folder, unpacked with <c>ditto</c> into a hidden folder
/// beside the app (<c>.Anemo Desktop.update</c>, same volume, so the swap is a rename), checked
/// with <c>codesign --verify</c> and against the running app's signature, run once with
/// <c>--self-test</c>, and swapped in at quit; the old bundle is kept as <c>.Anemo Desktop.old.app</c>.
/// </summary>
internal sealed class MacUpdatePlatform : IUpdatePlatform
{
    private const string Ditto = "/usr/bin/ditto";
    private const string Codesign = "/usr/bin/codesign";
    private static readonly TimeSpan ToolTimeout = TimeSpan.FromMinutes(2);

    private readonly string _bundle;
    private readonly string _parent;
    private readonly string _staging;
    private readonly MacSignature? _running;

    /// <param name="executable">The running binary (<see cref="Environment.ProcessPath"/>), inside <c>X.app/Contents/MacOS</c>.</param>
    /// <param name="updatesFolder">Anemo Desktop's <c>updates</c> folder in Application Support.</param>
    public MacUpdatePlatform(string? executable, string updatesFolder, Architecture architecture)
        : this(executable, updatesFolder, architecture, bundle => Signature(bundle).GetAwaiter().GetResult())
    {
    }

    /// <param name="runningSignature">Reads the running bundle's signature (tests give one that a real build would have).</param>
    internal MacUpdatePlatform(string? executable, string updatesFolder, Architecture architecture, Func<string, MacSignature?> runningSignature)
    {
        _bundle = BundleOf(executable) ?? "";
        _parent = Path.GetDirectoryName(_bundle) ?? "";
        var name = Path.GetFileNameWithoutExtension(_bundle);
        _staging = Path.Combine(_parent, $".{name}.update");
        Staged = Path.Combine(_staging, Path.GetFileName(_bundle));
        Previous = Path.Combine(_parent, $".{name}.old.app");
        DownloadPath = Path.Combine(updatesFolder, AssetName);
        Unavailable = _bundle.Length == 0
            ? "This copy isn't an installed Anemo Desktop.app (a development build), so it doesn't update itself."
            : architecture != Architecture.Arm64
                ? "Only an Apple Silicon build is published, so this Mac doesn't update itself."
                : !CanWrite(_parent)
                    ? $"Anemo Desktop can't write to {_parent}, so it can't replace itself there. Move it to /Applications as an administrator, or to ~/Applications."
                    : null;
        if (Unavailable is null)
        {
            _running = runningSignature(_bundle);
        }
    }

    public string? Unavailable { get; }

    public string AssetName => "Anemo-Desktop-macos-arm64.zip";

    public string ChecksumsName => "SHA256SUMS-desktop-macos.txt";

    /// <summary>
    /// An ad hoc signature is new with every build, and macOS ties Screen Recording and
    /// Accessibility to it: after an update both have to be allowed again.
    /// </summary>
    public string? Note => _running is { TeamId: not null }
        ? null
        : "This build isn't signed by a developer (ad hoc): after an update macOS forgets Screen Recording and Accessibility. Remove Anemo Desktop from both lists in System Settings → Privacy & Security, then allow it again.";

    public string DownloadPath { get; }

    private string Staged { get; }

    private string Previous { get; }

    public IUpdateFiles Files => DiskUpdateFiles.Instance;

    public IUpdateLauncher Launcher { get; } = new MacLauncher();

    public void CleanUp()
    {
        Files.Delete(DownloadPath);
        Files.Delete(_staging);
    }

    public async Task<StagedUpdate> PrepareAsync(string downloaded, AppVersion version, CancellationToken ct)
    {
        Files.Delete(_staging);
        Directory.CreateDirectory(_staging);
        try
        {
            if ((await Run(Ditto, ["-x", "-k", downloaded, _staging], ct)).Code != 0
                || !File.Exists(Path.Combine(Staged, "Contents", "MacOS", "Anemo Desktop")))
            {
                throw new UpdateRefusedException($"The download of {version} isn't an Anemo Desktop app, so it isn't installed.");
            }

            if ((await Run(Codesign, ["--verify", "--deep", "--strict", Staged], ct)).Code != 0)
            {
                throw new UpdateRefusedException($"The signature of the downloaded {version} isn't intact, so it isn't installed.");
            }

            // What -dv reports below is only what the signature claims; with a Developer ID, codesign
            // checks the certificate chain too: issued by Apple, to this app's team.
            if (_running is not null && MacSignature.Requirement(_running) is { } requirement
                && (await Run(Codesign, ["--verify", "--deep", "--strict", $"-R={requirement}", Staged], ct)).Code != 0)
            {
                throw new UpdateRefusedException($"The downloaded {version} isn't signed with this app's Apple Developer ID ({_running.TeamId}), so it isn't installed.");
            }

            if (MacSignature.Refusal(_running, await Signature(Staged, ct)) is { } refusal)
            {
                throw new UpdateRefusedException(refusal);
            }

            var selfTest = await Run(Path.Combine(Staged, "Contents", "MacOS", "Anemo Desktop"), [UpdateInstaller.SelfTestArgument], ct);
            if (selfTest.Code != 0 || selfTest.Output.Trim() != $"Anemo Desktop {version}")
            {
                throw new UpdateRefusedException($"The downloaded Anemo Desktop {version} didn't start properly, so it isn't installed.");
            }

            return new StagedUpdate(version, new UpdatePaths(_bundle, Staged, Previous));
        }
        catch
        {
            Files.Delete(_staging);
            throw;
        }
        finally
        {
            Files.Delete(downloaded);
        }
    }

    /// <summary><c>/Applications/Anemo Desktop.app</c> for <c>/Applications/Anemo Desktop.app/Contents/MacOS/Anemo Desktop</c>, else null.</summary>
    internal static string? BundleOf(string? executable)
    {
        var macOs = Path.GetDirectoryName(executable ?? "");
        var contents = Path.GetDirectoryName(macOs ?? "");
        var bundle = Path.GetDirectoryName(contents ?? "");
        return Path.GetFileName(macOs) == "MacOS" && Path.GetFileName(contents) == "Contents"
            && bundle is not null && bundle.EndsWith(".app", StringComparison.Ordinal)
                ? bundle
                : null;
    }

    private static async Task<MacSignature?> Signature(string bundle, CancellationToken ct = default)
    {
        var result = await Run(Codesign, ["-dv", "--verbose=2", bundle], ct);
        return result.Code == 0 ? MacSignature.Parse(result.Error) : null;
    }

    private static async Task<(int Code, string Output, string Error)> Run(string file, string[] args, CancellationToken ct)
    {
        var info = new ProcessStartInfo(file) { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var arg in args)
        {
            info.ArgumentList.Add(arg);
        }

        using var process = Process.Start(info) ?? throw new IOException($"{file} didn't start");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(ToolTimeout);
        try
        {
            var output = process.StandardOutput.ReadToEndAsync(timeout.Token);
            var error = process.StandardError.ReadToEndAsync(timeout.Token);
            await process.WaitForExitAsync(timeout.Token);
            return (process.ExitCode, await output, await error);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            process.Kill(entireProcessTree: true);
            return (-1, "", "");
        }
    }

    private static bool CanWrite(string folder)
    {
        var probe = Path.Combine(folder, $".anemo-write-test-{Guid.NewGuid():N}");
        try
        {
            File.WriteAllBytes(probe, []);
            File.Delete(probe);
            return true;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    /// <summary>Starts the app through LaunchServices (<c>open -n</c>), so macOS treats it as its own app, not as a child of this one.</summary>
    private sealed class MacLauncher : IUpdateLauncher
    {
        public IUpdateProcess? Start(string appPath, string? argument)
        {
            var info = new ProcessStartInfo("/usr/bin/open") { UseShellExecute = false };
            info.ArgumentList.Add("-n");
            info.ArgumentList.Add(appPath);
            if (argument is not null)
            {
                info.ArgumentList.Add("--args");
                info.ArgumentList.Add(argument);
            }

            using var open = Process.Start(info);
            open?.WaitForExit(10_000);
            return null; // open returns at once; the started-file says whether the app came up
        }
    }
}
