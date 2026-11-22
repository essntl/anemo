using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Anemo.Desktop.Core.Platform;

namespace Anemo.Desktop.Platform;

/// <summary>The clipboard; it needs an STA thread, so each call gets its own.</summary>
internal sealed class WindowsClipboard : IClipboard
{
    public void SetText(string text)
    {
        Exception? error = null;
        var thread = new Thread(() =>
        {
            try
            {
                if (text.Length == 0)
                {
                    Clipboard.Clear();
                }
                else
                {
                    Clipboard.SetDataObject(text, copy: true, retryTimes: 10, retryDelay: 100);
                }
            }
            catch (Exception e)
            {
                error = e;
            }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        if (error is not null)
        {
            throw Core.Commands.CommandException.Failed("The clipboard is in use by another program; try again.");
        }
    }
}

/// <summary>The token protected with DPAPI for the current Windows user.</summary>
internal sealed class DpapiProtector : ITokenProtector
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("Anemo Desktop device token");

    public string Protect(string token) =>
        Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(token), Entropy, DataProtectionScope.CurrentUser));

    public string? Unprotect(string protectedToken)
    {
        try
        {
            return Encoding.UTF8.GetString(
                ProtectedData.Unprotect(Convert.FromBase64String(protectedToken), Entropy, DataProtectionScope.CurrentUser));
        }
        catch (Exception e) when (e is CryptographicException or FormatException)
        {
            return null;
        }
    }
}

/// <summary>
/// Programs from the Start menu (every app in <c>shell:AppsFolder</c>, store apps included)
/// and URLs in the default browser.
/// </summary>
internal sealed class StartMenuLauncher : IAppLauncher
{
    private static readonly TimeSpan CacheFor = TimeSpan.FromMinutes(1);
    private IReadOnlyList<StartMenuApp> _apps = [];
    private DateTime _readAt = DateTime.MinValue;

    public IReadOnlyList<StartMenuApp> ListApps()
    {
        if (DateTime.UtcNow - _readAt > CacheFor)
        {
            _apps = OnStaThread(ReadAppsFolder);
            _readAt = DateTime.UtcNow;
        }

        return _apps;
    }

    public void Launch(StartMenuApp app)
    {
        try
        {
            Process.Start(new ProcessStartInfo("explorer.exe", $"shell:AppsFolder\\{app.LaunchId}") { UseShellExecute = true });
        }
        catch (System.ComponentModel.Win32Exception)
        {
            throw Core.Commands.CommandException.Failed($"Windows couldn't start “{app.Name}”.");
        }
    }

    public void OpenUrl(Uri url)
    {
        if (url.Scheme is not ("http" or "https"))
        {
            throw new ArgumentException("Only http and https URLs are opened.", nameof(url));
        }

        try
        {
            Process.Start(new ProcessStartInfo(url.AbsoluteUri) { UseShellExecute = true });
        }
        catch (System.ComponentModel.Win32Exception)
        {
            throw Core.Commands.CommandException.Failed("There is no default browser to open the address with.");
        }
    }

    private static List<StartMenuApp> ReadAppsFolder()
    {
        var apps = new List<StartMenuApp>();
        var type = Type.GetTypeFromProgID("Shell.Application");
        if (type is null)
        {
            return apps;
        }

        dynamic shell = Activator.CreateInstance(type)!;
        dynamic folder = shell.NameSpace("shell:AppsFolder");
        foreach (dynamic item in folder.Items())
        {
            string name = item.Name;
            string path = item.Path;
            if (!string.IsNullOrWhiteSpace(name) && !string.IsNullOrWhiteSpace(path))
            {
                apps.Add(new StartMenuApp(name, path));
            }
        }

        return apps;
    }

    private static T OnStaThread<T>(Func<T> read)
    {
        T result = default!;
        Exception? error = null;
        var thread = new Thread(() =>
        {
            try
            {
                result = read();
            }
            catch (Exception e)
            {
                error = e;
            }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        return error is null ? result : throw Core.Commands.CommandException.Failed("The Start menu couldn't be read.");
    }
}

/// <summary>PowerShell: pwsh when installed, else Windows PowerShell 5.1, hidden, output read as UTF-8.</summary>
internal sealed class PowerShellHost : IShellHost
{
    public string? FindPowerShell()
    {
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator))
        {
            var candidate = Path.Combine(dir.Trim(), "pwsh.exe");
            if (dir.Length > 0 && File.Exists(candidate))
            {
                return candidate;
            }
        }

        var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        var pwsh = Path.Combine(programFiles, "PowerShell", "7", "pwsh.exe");
        if (File.Exists(pwsh))
        {
            return pwsh;
        }

        var windowsPowerShell = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
        return File.Exists(windowsPowerShell) ? windowsPowerShell : null;
    }

    public async Task<int> RunAsync(ShellStart start, Action<string> onStdout, Action<string> onStderr, CancellationToken ct)
    {
        var info = new ProcessStartInfo(start.FileName)
        {
            WorkingDirectory = Expand(start.WorkingDirectory),
            UseShellExecute = false,
            CreateNoWindow = true,
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
        ShellJob.Add(process);
        process.StandardInput.Close();
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
                // It ended on its own meanwhile.
            }

            throw;
        }

        process.WaitForExit(); // flushes the asynchronous output readers
        return process.ExitCode;
    }

    public void EnsureFolder(string path) => Directory.CreateDirectory(Expand(path));

    private static string Expand(string path) => Environment.ExpandEnvironmentVariables(path);
}

/// <summary>"Start with Windows": a shortcut in the user's Startup folder (no admin rights, no registry).</summary>
internal static class StartupShortcut
{
    private static string ShortcutPath =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), "Anemo Desktop.lnk");

    public static void Apply(bool enabled)
    {
        if (!enabled)
        {
            if (File.Exists(ShortcutPath))
            {
                File.Delete(ShortcutPath);
            }

            return;
        }

        var exe = Environment.ProcessPath;
        if (exe is null)
        {
            return;
        }

        var type = Type.GetTypeFromProgID("WScript.Shell") ?? throw new InvalidOperationException("WScript.Shell is missing.");
        dynamic shell = Activator.CreateInstance(type)!;
        dynamic link = shell.CreateShortcut(ShortcutPath);
        link.TargetPath = exe;
        link.WorkingDirectory = Path.GetDirectoryName(exe);
        link.Description = "Anemo Desktop";
        link.Save();
    }
}
