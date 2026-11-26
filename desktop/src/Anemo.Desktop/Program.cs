using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Anemo.Desktop.Core.Storage;
using Anemo.Desktop.Core.Updates;
using Anemo.Desktop.UI;

namespace Anemo.Desktop;

internal static class Program
{
    /// <summary>"Local\" makes the name per Windows session: one instance per logged-in user.</summary>
    private const string InstanceMutex = @"Local\Anemo.Desktop.SingleInstance";

    /// <summary>A copy started by an update waits this long for the old one to let go of the instance.</summary>
    private static readonly TimeSpan HandOver = TimeSpan.FromSeconds(30);

    public static string Version => typeof(Program).Assembly.GetName().Version?.ToString(3) ?? "1.0.0";

    [STAThread]
    private static int Main(string[] args)
    {
        // The updater's check of a downloaded exe, before anything else (no window, no instance check).
        if (args.Contains(UpdateInstaller.SelfTestArgument))
        {
            Console.Out.Write("Anemo Desktop " + Version);
            Console.Out.Flush();
            return 0;
        }

        var updated = args.Contains(UpdateInstaller.UpdatedArgument);
        var mutex = new Mutex(initiallyOwned: true, InstanceMutex, out var first);
        if (!first && updated)
        {
            first = WaitForInstance(mutex);
        }

        if (!first)
        {
            mutex.Dispose();
            MessageBox.Show(
                "Anemo Desktop is already running: look for its icon in the notification area.",
                "Anemo Desktop",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
            return 0;
        }

        // Anything unexpected is logged (type and redacted message) instead of a crash dialog.
        var log = new DiagnosticLog(AppPaths.LogFolder, TimeProvider.System);
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (_, e) => Log(log, "UI", e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Log(log, "fatal", e.ExceptionObject as Exception);
        TaskScheduler.UnobservedTaskException += (_, e) =>
        {
            Log(log, "task", e.Exception);
            e.SetObserved();
        };

        ApplicationConfiguration.Initialize();
        TrayApp.Install? install;
        using (var app = new TrayApp(updated))
        {
            Application.Run(app);
            install = app.TakeInstall();
        }

        // Let go of the instance first: a restarted copy waits for it.
        mutex.ReleaseMutex();
        mutex.Dispose();
        if (install is not null)
        {
            if (install.Restart)
            {
                install.Installer.InstallAndRestartAsync(install.Update).GetAwaiter().GetResult();
            }
            else
            {
                install.Installer.InstallOnQuit(install.Update);
            }
        }

        return 0;
    }

    private static bool WaitForInstance(Mutex mutex)
    {
        try
        {
            return mutex.WaitOne(HandOver);
        }
        catch (AbandonedMutexException)
        {
            return true; // the old copy ended without letting go: the instance is ours
        }
    }

    /// <summary>The exception's type, message and stack, through the log's token redaction.</summary>
    private static void Log(DiagnosticLog log, string where, Exception? e) =>
        log.Info($"unhandled ({where}): {e?.GetType().Name}: {e?.Message}{Environment.NewLine}{e?.StackTrace}");
}
