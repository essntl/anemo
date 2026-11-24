using System.Diagnostics;
using System.Text;
using Anemo.Desktop.Core.Commands;
using Anemo.Desktop.Core.Platform;
using Anemo.Desktop.Mac.Native;

namespace Anemo.Desktop.Mac.Platform;

/// <summary>Apps and URLs: NSWorkspace for the front app, <c>/usr/bin/open</c> to start things.</summary>
internal sealed class MacApps : IAppLauncher
{
    private const long ActivateAllWindows = 1 << 0; // NSApplicationActivateAllWindows
    private const long ActivateIgnoringOtherApps = 1 << 1; // NSApplicationActivateIgnoringOtherApps

    public sealed record Running(int Pid, string? BundleId);

    /// <summary>The app in front (the one with the menu bar).</summary>
    public static Running? Frontmost() => ObjC.InPool(() =>
    {
        var workspace = ObjC.Call(ObjC.Class("NSWorkspace"), "sharedWorkspace");
        var app = ObjC.Call(workspace, "frontmostApplication");
        return app == 0
            ? null
            : new Running(ObjC.SendReturnInt(app, ObjC.Selector("processIdentifier")), ObjC.FromNSString(ObjC.Call(app, "bundleIdentifier")));
    });

    /// <summary>Brings the app to the front: NSRunningApplication, and Accessibility's AXFrontmost (which macOS 14 honours more often).</summary>
    public static void Activate(int pid)
    {
        ObjC.InPool(() =>
        {
            var app = ObjC.SendLong(ObjC.Class("NSRunningApplication"), ObjC.Selector("runningApplicationWithProcessIdentifier:"), pid);
            if (app != 0)
            {
                ObjC.SendLong(app, ObjC.Selector("activateWithOptions:"), ActivateAllWindows | ActivateIgnoringOtherApps);
            }
        });
        var ax = AX.Application(pid);
        AX.SetBool(ax, "AXFrontmost", true);
        CF.Release(ax);
    }

    /// <summary>The apps in the Applications folders (the Mac's counterpart of the Start menu).</summary>
    public IReadOnlyList<StartMenuApp> ListApps()
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var folders = new[]
        {
            "/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities",
            "/System/Library/CoreServices/Applications", Path.Combine(home, "Applications"),
        };
        var apps = new List<StartMenuApp>();
        foreach (var folder in folders.Where(Directory.Exists))
        {
            foreach (var app in Directory.EnumerateDirectories(folder, "*.app"))
            {
                apps.Add(new StartMenuApp(Path.GetFileNameWithoutExtension(app), app));
            }
        }

        return apps.DistinctBy(a => a.Name, StringComparer.OrdinalIgnoreCase).OrderBy(a => a.Name, StringComparer.OrdinalIgnoreCase).ToList();
    }

    public void Launch(StartMenuApp app) => Open(["-a", app.LaunchId]);

    public void OpenUrl(Uri url) => Open([url.AbsoluteUri]);

    /// <summary><c>open</c> with these arguments, never through a shell.</summary>
    private static void Open(string[] args)
    {
        var info = new ProcessStartInfo("/usr/bin/open") { UseShellExecute = false };
        foreach (var arg in args)
        {
            info.ArgumentList.Add(arg);
        }

        using var process = Process.Start(info) ?? throw CommandException.Failed("macOS didn't open it.");
        if (!process.WaitForExit(10_000) || process.ExitCode != 0)
        {
            throw CommandException.Failed("macOS couldn't open it.");
        }
    }
}

/// <summary>The clipboard (NSPasteboard).</summary>
internal sealed class MacClipboard : IClipboard
{
    public void SetText(string text) => ObjC.InPool(() =>
    {
        var board = ObjC.Call(ObjC.Class("NSPasteboard"), "generalPasteboard");
        ObjC.SendReturnLong(board, ObjC.Selector("clearContents"));
        ObjC.SendBool(board, ObjC.Selector("setString:forType:"), ObjC.NSString(text), ObjC.NSString("public.utf8-plain-text"));
    });
}

/// <summary>
/// The shell: <c>/bin/zsh</c>, else <c>/bin/bash</c> (docs/specs/09-desktop-macos.md D5), with
/// the PATH of <see cref="PosixPath.Augmented"/>, stdin closed, the output read as UTF-8.
/// Cancelling ends the shell and what it started.
/// </summary>
internal sealed class MacShellHost : IShellHost
{
    public ShellProgram? FindShell() =>
        File.Exists("/bin/zsh") ? ShellProgram.At("/bin/zsh") : File.Exists("/bin/bash") ? ShellProgram.At("/bin/bash") : null;

    public async Task<int> RunAsync(ShellStart start, Action<string> onStdout, Action<string> onStderr, CancellationToken ct)
    {
        var info = new ProcessStartInfo(start.FileName)
        {
            WorkingDirectory = start.WorkingDirectory,
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var arg in start.Arguments)
        {
            info.ArgumentList.Add(arg);
        }

        foreach (var (key, value) in MacEnvironment.ForChildren())
        {
            info.Environment[key] = value;
        }

        using var process = new Process { StartInfo = info };
        process.OutputDataReceived += (_, e) =>
        {
            if (e.Data is not null)
            {
                onStdout(e.Data);
            }
        };
        process.ErrorDataReceived += (_, e) =>
        {
            if (e.Data is not null)
            {
                onStderr(e.Data);
            }
        };
        process.Start();
        process.StandardInput.Close(); // never waits for input
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        try
        {
            await process.WaitForExitAsync(ct);
        }
        catch (OperationCanceledException)
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
                // ended meanwhile
            }

            throw;
        }

        process.WaitForExit(); // flushes the readers
        return process.ExitCode;
    }

    public void EnsureFolder(string path) => Directory.CreateDirectory(path);
}

/// <summary>The environment for the shell and for Claude Code jobs: the app's own, with a PATH that finds Homebrew and Claude Code.</summary>
internal static class MacEnvironment
{
    public static Dictionary<string, string> ForChildren()
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var etcPaths = File.Exists("/etc/paths") ? File.ReadAllLines("/etc/paths") : [];
        var env = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (System.Collections.DictionaryEntry e in Environment.GetEnvironmentVariables())
        {
            env[(string)e.Key] = (string?)e.Value ?? "";
        }

        env["PATH"] = PosixPath.Augmented(Environment.GetEnvironmentVariable("PATH"), home, etcPaths);
        env.TryAdd("HOME", home);
        env.TryAdd("LANG", "en_US.UTF-8"); // an app from Finder has no LANG: tools would write ASCII
        return env;
    }

    /// <summary>A program on the augmented PATH (executable files only, no relative folders).</summary>
    public static string? Find(string program) =>
        PosixPath.Find(program, ForChildren()["PATH"], IsExecutable);

    private static bool IsExecutable(string path) =>
        File.Exists(path) && (File.GetUnixFileMode(path) & (UnixFileMode.UserExecute | UnixFileMode.GroupExecute | UnixFileMode.OtherExecute)) != 0;
}

/// <summary>
/// The device token in the login Keychain; settings.json keeps only <see cref="Marker"/>
/// (docs/specs/09-desktop-macos.md D8).
/// </summary>
internal sealed class KeychainTokenProtector(string service = KeychainTokenProtector.Service) : ITokenProtector
{
    public const string Service = "Anemo Desktop";
    public const string Account = "device-token";
    public const string Marker = "keychain:v1";

    public string Protect(string token)
    {
        var status = Keychain.Save(service, Account, token);
        return status == Keychain.Ok ? Marker : throw new InvalidOperationException($"The Keychain didn't store the token (OSStatus {status}).");
    }

    public string? Unprotect(string protectedToken) => protectedToken == Marker ? Keychain.Read(service, Account) : null;
}
