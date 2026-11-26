using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using Anemo.Desktop.Core.Updates;

namespace Anemo.Desktop.Platform;

/// <summary>
/// Updates of the single-file exe (docs/specs/23-desktop-auto-update.md, "Windows"). Everything
/// happens in the exe's own folder, so every step is a rename on one drive and no admin rights
/// are needed:
/// <c>Anemo Desktop.download</c> (being downloaded) → <c>Anemo Desktop.new.exe</c> (checked, ready) →
/// swapped in at quit, the running exe kept as <c>Anemo Desktop.old.exe</c> until the next update.
/// </summary>
internal sealed class WindowsUpdatePlatform : IUpdatePlatform
{
    private static readonly TimeSpan SelfTestTimeout = TimeSpan.FromSeconds(60);

    private readonly string _exe;
    private readonly string _folder;
    private readonly string _stem;

    /// <param name="exe">The running exe (<see cref="Environment.ProcessPath"/>).</param>
    /// <param name="singleFile">
    /// True for the published exe. A build from <c>dotnet build</c> is a small launcher beside
    /// its dlls: replacing only the launcher would break it, so such a copy doesn't update.
    /// </param>
    public WindowsUpdatePlatform(string? exe, bool singleFile, Architecture architecture)
    {
        _exe = exe ?? "";
        _folder = Path.GetDirectoryName(_exe) ?? "";
        _stem = Path.GetFileNameWithoutExtension(_exe);
        AssetName = architecture switch
        {
            Architecture.X64 => "Anemo-Desktop-win-x64.exe",
            Architecture.Arm64 => "Anemo-Desktop-win-arm64.exe",
            _ => "",
        };
        Unavailable = !singleFile || exe is null || !exe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
            ? "This is a development build, not the published exe, so it doesn't update itself."
            : AssetName.Length == 0
                ? "No Anemo Desktop is published for this processor, so it doesn't update itself."
                : !CanWrite(_folder)
                    ? $"Anemo Desktop can't write to {_folder}, so it can't update itself there. Move it to a folder of yours, e.g. %LOCALAPPDATA%\\Programs\\Anemo Desktop."
                    : null;
    }

    public string? Unavailable { get; }

    public string AssetName { get; }

    public string ChecksumsName => "SHA256SUMS-desktop.txt";

    public string? Note => null;

    public string DownloadPath => Path.Combine(_folder, _stem + ".download");

    private string Staged => Path.Combine(_folder, _stem + ".new.exe");

    private string Previous => Path.Combine(_folder, _stem + ".old.exe");

    public IUpdateFiles Files => DiskUpdateFiles.Instance;

    public IUpdateLauncher Launcher { get; } = new WindowsLauncher();

    public void CleanUp()
    {
        Files.Delete(DownloadPath);
        Files.Delete(Staged);
    }

    public async Task<StagedUpdate> PrepareAsync(string downloaded, AppVersion version, CancellationToken ct)
    {
        File.Move(downloaded, Staged, overwrite: true);
        try
        {
            // The version resource the release workflow checked, then the exe itself saying it.
            var info = FileVersionInfo.GetVersionInfo(Staged);
            if (info.ProductName != "Anemo Desktop" || !version.IsProductVersion(info.ProductVersion))
            {
                throw new UpdateRefusedException($"The downloaded file isn't Anemo Desktop {version}, so it isn't installed.");
            }

            var said = await SelfTestAsync(Staged, ct);
            if (said != $"Anemo Desktop {version}")
            {
                throw new UpdateRefusedException($"The downloaded Anemo Desktop {version} didn't start properly, so it isn't installed.");
            }

            return new StagedUpdate(version, new UpdatePaths(_exe, Staged, Previous));
        }
        catch
        {
            Files.Delete(Staged);
            throw;
        }
    }

    /// <summary>Starts the exe with <c>--self-test</c> (it prints its version and exits, before its single-instance check).</summary>
    private static async Task<string?> SelfTestAsync(string exe, CancellationToken ct)
    {
        var info = new ProcessStartInfo(exe)
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            CreateNoWindow = true,
            WorkingDirectory = Path.GetDirectoryName(exe)!,
        };
        info.ArgumentList.Add(UpdateInstaller.SelfTestArgument);
        using var process = Process.Start(info);
        if (process is null)
        {
            return null;
        }

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(SelfTestTimeout);
        try
        {
            var output = await process.StandardOutput.ReadToEndAsync(timeout.Token);
            await process.WaitForExitAsync(timeout.Token);
            return process.ExitCode == 0 ? output.Trim() : null;
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            process.Kill(entireProcessTree: true);
            return null;
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

    private sealed class WindowsLauncher : IUpdateLauncher
    {
        public IUpdateProcess? Start(string appPath, string? argument)
        {
            var info = new ProcessStartInfo(appPath) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(appPath)! };
            if (argument is not null)
            {
                info.ArgumentList.Add(argument);
            }

            var process = Process.Start(info);
            return process is null ? null : new Started(process);
        }
    }

    private sealed class Started(Process process) : IUpdateProcess
    {
        public bool HasExited => process.HasExited;

        public void Kill() => process.Kill(entireProcessTree: true);
    }
}
