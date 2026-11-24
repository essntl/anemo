using Anemo.Desktop.Core.Storage;
using Avalonia;

namespace Anemo.Desktop.Mac;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        Directory.CreateDirectory(AppPaths.Folder);

        // One copy per user. Finder already brings a running app to the front instead of
        // starting it again; this covers a start from Terminal.
        FileStream instance;
        try
        {
            instance = new FileStream(AppPaths.InstanceLock, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        }
        catch (IOException)
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

        return 0;
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
}
