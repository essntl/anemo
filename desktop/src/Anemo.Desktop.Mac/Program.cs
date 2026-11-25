using Anemo.Desktop.Core.Storage;
using Anemo.Desktop.Core.Updates;
using Anemo.Desktop.Mac.UI;
using Avalonia;

namespace Anemo.Desktop.Mac;

internal static class Program
{
    /// <summary>A copy started by an update waits this long for the old one to let go of the instance.</summary>
    private static readonly TimeSpan HandOver = TimeSpan.FromSeconds(30);

    public static string Version => typeof(Program).Assembly.GetName().Version?.ToString(3) ?? "1.0.0";

    /// <summary>Started by an update (<c>--updated</c>).</summary>
    public static bool Updated { get; private set; }

    /// <summary>Set by the menu bar app as it closes: the update to swap in once the instance lock is let go.</summary>
    public static MenuBarApp.Install? PendingInstall { get; set; }

    [STAThread]
    private static int Main(string[] args)
    {
        // The updater's check of a downloaded app, before anything else (no window, no instance lock).
        if (args.Contains(UpdateInstaller.SelfTestArgument))
        {
            Console.Out.Write("Anemo Desktop " + Version);
            Console.Out.Flush();
            return 0;
        }

        Updated = args.Contains(UpdateInstaller.UpdatedArgument);
        Directory.CreateDirectory(AppPaths.Folder);

        // One copy per user. Finder already brings a running app to the front instead of
        // starting it again; this covers a start from Terminal.
        var instance = TakeInstance(Updated ? HandOver : TimeSpan.Zero);
        if (instance is null)
        {
            Console.Error.WriteLine("Anemo Desktop is already running: its mark is in the menu bar.");
            return 0;
        }

        // Anything unexpected is logged (type and redacted message) instead of a crash report.
        var log = new DiagnosticLog(AppPaths.LogFolder, TimeProvider.System);
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Log(log, "fatal", e.ExceptionObject as Exception);
        TaskScheduler.UnobservedTaskException += (_, e) =>
        {
            Log(log, "task", e.Exception);
            e.SetObserved();
        };

        using (instance)
        {
            BuildAvaloniaApp().StartWithClassicDesktopLifetime(args, Avalonia.Controls.ShutdownMode.OnExplicitShutdown);
        }

        // The lock is let go: a restarted copy can take it.
        if (PendingInstall is { } install)
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

    private static FileStream? TakeInstance(TimeSpan wait)
    {
        var until = DateTimeOffset.UtcNow + wait;
        while (true)
        {
            try
            {
                return new FileStream(AppPaths.InstanceLock, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            }
            catch (IOException) when (DateTimeOffset.UtcNow < until)
            {
                Thread.Sleep(250);
            }
            catch (IOException)
            {
                return null;
            }
        }
    }

    /// <summary>Also used by Avalonia's designer.</summary>
    public static AppBuilder BuildAvaloniaApp() =>
        AppBuilder.Configure<App>()
            .UsePlatformDetect()
            .With(new MacOSPlatformOptions { ShowInDock = false }) // a menu bar app (also LSUIElement in Info.plist)
            .LogToTrace();

    private static void Log(DiagnosticLog log, string where, Exception? e) =>
        log.Info($"unhandled ({where}): {e?.GetType().Name}: {e?.Message}{Environment.NewLine}{e?.StackTrace}");
}

/// <summary>Where the app keeps its files: <c>~/Library/Application Support/Anemo Desktop</c>.</summary>
internal static class AppPaths
{
    private static string Home => Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

    public static string Folder => Path.Combine(Home, "Library", "Application Support", "Anemo Desktop");

    public static string SettingsFile => Path.Combine(Folder, "settings.json");

    public static string InstanceLock => Path.Combine(Folder, "instance.lock");

    /// <summary>The command log and the connection log (7 days each).</summary>
    public static string LogFolder => Path.Combine(Folder, "logs");

    /// <summary>The shell's folder when Settings names none.</summary>
    public static string DefaultWorkFolder => Path.Combine(Home, "AnemoWork");

    public static string HomeFolder => Home;

    /// <summary>The updater's download and marks.</summary>
    public static string UpdatesFolder => Path.Combine(Folder, "updates");
}
