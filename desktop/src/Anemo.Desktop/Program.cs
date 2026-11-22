using System;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Anemo.Desktop.Core.Storage;
using Anemo.Desktop.UI;

namespace Anemo.Desktop;

internal static class Program
{
    /// <summary>"Local\" makes the name per Windows session: one instance per logged-in user.</summary>
    private const string InstanceMutex = @"Local\Anemo.Desktop.SingleInstance";

    [STAThread]
    private static int Main()
    {
        using var mutex = new Mutex(initiallyOwned: true, InstanceMutex, out var first);
        if (!first)
        {
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
        using var app = new TrayApp();
        Application.Run(app);
        return 0;
    }

    /// <summary>The exception's type, message and stack, through the log's token redaction.</summary>
    private static void Log(DiagnosticLog log, string where, Exception? e) =>
        log.Info($"unhandled ({where}): {e?.GetType().Name}: {e?.Message}{Environment.NewLine}{e?.StackTrace}");
}
