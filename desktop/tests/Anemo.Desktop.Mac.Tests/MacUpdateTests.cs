using System.Diagnostics;
using System.Runtime.InteropServices;
using Anemo.Desktop.Core.Updates;
using Anemo.Desktop.Mac.Platform;

namespace Anemo.Desktop.Mac.Tests;

/// <summary>
/// The macOS update path for real, with two tiny ad hoc signed bundles (a shell script as the
/// executable) in a temporary folder: ditto, codesign --verify, the signature compared with
/// the "running" app's, the --self-test run and the swap of bundles. Nothing under /Applications.
/// </summary>
[System.Runtime.Versioning.SupportedOSPlatform("macos")] // skipped elsewhere (MacFact)
public sealed class MacUpdateTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "anemo-mac-update-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_root))
        {
            Directory.Delete(_root, true);
        }
    }

    [MacFact]
    public void The_bundle_is_found_from_the_executable()
    {
        Assert.Equal("/Applications/Anemo Desktop.app", MacUpdatePlatform.BundleOf("/Applications/Anemo Desktop.app/Contents/MacOS/Anemo Desktop"));
        Assert.Null(MacUpdatePlatform.BundleOf("/Users/me/dev/anemo/desktop/bin/Anemo Desktop"));
        Assert.Null(MacUpdatePlatform.BundleOf("/Applications/Anemo Desktop/Contents/MacOS/Anemo Desktop"));
        Assert.Null(MacUpdatePlatform.BundleOf(null));
    }

    [MacFact]
    public async Task A_signed_zip_of_the_same_app_is_staged_and_swapped_in()
    {
        var running = MakeApp(Path.Combine(_root, "Applications"), "1.8.0", "app.anemo.desktop");
        var zip = Zip(MakeApp(Path.Combine(_root, "build"), "1.9.0", "app.anemo.desktop"));
        var platform = Platform(running);
        Assert.Null(platform.Unavailable);
        Assert.NotNull(platform.Note); // ad hoc: the permissions go

        var staged = await platform.PrepareAsync(zip, new AppVersion(1, 9, 0), default);
        var installer = new UpdateInstaller(DiskUpdateFiles.Instance, platform.Launcher, new NullLog(), Path.Combine(_root, "updates"));

        Assert.Equal(InstallOutcome.Installed, installer.InstallOnQuit(staged));
        Assert.Equal("Anemo Desktop 1.9.0", SelfTest(running));
        Assert.True(Directory.Exists(staged.Paths.Previous));
        Assert.False(File.Exists(zip));
    }

    [MacFact]
    public async Task Another_bundle_identifier_or_a_wrong_version_is_refused()
    {
        var running = MakeApp(Path.Combine(_root, "Applications"), "1.8.0", "app.anemo.desktop");
        var platform = Platform(running);

        var other = Zip(MakeApp(Path.Combine(_root, "other"), "1.9.0", "com.example.other"));
        var e = await Assert.ThrowsAsync<UpdateRefusedException>(() => platform.PrepareAsync(other, new AppVersion(1, 9, 0), default));
        Assert.Contains("another bundle identifier", e.Message);

        var wrong = Zip(MakeApp(Path.Combine(_root, "wrong"), "1.9.1", "app.anemo.desktop"));
        await Assert.ThrowsAsync<UpdateRefusedException>(() => platform.PrepareAsync(wrong, new AppVersion(1, 9, 0), default));
        Assert.Equal("Anemo Desktop 1.8.0", SelfTest(running)); // untouched
    }

    [MacFact]
    public async Task A_bundle_changed_after_signing_is_refused()
    {
        var running = MakeApp(Path.Combine(_root, "Applications"), "1.8.0", "app.anemo.desktop");
        var tampered = MakeApp(Path.Combine(_root, "tampered"), "1.9.0", "app.anemo.desktop");
        File.AppendAllText(Path.Combine(tampered, "Contents", "MacOS", "Anemo Desktop"), "\necho extra\n");

        var e = await Assert.ThrowsAsync<UpdateRefusedException>(() => Platform(running).PrepareAsync(Zip(tampered), new AppVersion(1, 9, 0), default));
        Assert.Contains("isn't intact", e.Message);
    }

    private MacUpdatePlatform Platform(string bundle) =>
        new(Path.Combine(bundle, "Contents", "MacOS", "Anemo Desktop"), Path.Combine(_root, "updates"), Architecture.Arm64);

    /// <summary>A bundle whose executable prints its version for --self-test, signed ad hoc.</summary>
    private static string MakeApp(string folder, string version, string identifier)
    {
        var app = Path.Combine(folder, "Anemo Desktop.app");
        var macOs = Path.Combine(app, "Contents", "MacOS");
        Directory.CreateDirectory(macOs);
        File.WriteAllText(Path.Combine(app, "Contents", "Info.plist"), $"""
            <?xml version="1.0" encoding="UTF-8"?>
            <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
            <plist version="1.0"><dict>
              <key>CFBundleExecutable</key><string>Anemo Desktop</string>
              <key>CFBundleIdentifier</key><string>{identifier}</string>
              <key>CFBundlePackageType</key><string>APPL</string>
              <key>CFBundleShortVersionString</key><string>{version}</string>
            </dict></plist>
            """);
        var exe = Path.Combine(macOs, "Anemo Desktop");
        File.WriteAllText(exe, $"#!/bin/sh\nprintf 'Anemo Desktop {version}'\n");
        File.SetUnixFileMode(exe, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute | UnixFileMode.GroupRead | UnixFileMode.OtherRead);
        Run("/usr/bin/codesign", "--force", "--sign", "-", "--identifier", identifier, app);
        return app;
    }

    private static string Zip(string app)
    {
        var zip = Path.Combine(Path.GetDirectoryName(app)!, "Anemo-Desktop-macos-arm64.zip");
        Run("/usr/bin/ditto", "-c", "-k", "--keepParent", app, zip);
        return zip;
    }

    private static string SelfTest(string app) => Run(Path.Combine(app, "Contents", "MacOS", "Anemo Desktop"), UpdateInstaller.SelfTestArgument);

    private static string Run(string file, params string[] args)
    {
        var info = new ProcessStartInfo(file) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
        foreach (var arg in args)
        {
            info.ArgumentList.Add(arg);
        }

        using var process = Process.Start(info)!;
        var output = process.StandardOutput.ReadToEnd();
        var error = process.StandardError.ReadToEnd();
        process.WaitForExit();
        Assert.True(process.ExitCode == 0, $"{file} failed: {error}");
        return output;
    }

    private sealed class NullLog : Core.Storage.IDiagnosticLog
    {
        public void Info(string message)
        {
        }
    }
}
