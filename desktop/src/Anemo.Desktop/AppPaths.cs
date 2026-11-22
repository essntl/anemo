using System;
using System.IO;

namespace Anemo.Desktop;

/// <summary>Where the client keeps its files: <c>%APPDATA%\Anemo Desktop</c>.</summary>
internal static class AppPaths
{
    public static string Folder =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Anemo Desktop");

    public static string SettingsFile => Path.Combine(Folder, "settings.json");

    /// <summary>The command log and the connection log (7 days each).</summary>
    public static string LogFolder => Path.Combine(Folder, "logs");

    public static string DefaultWorkFolder =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "AnemoWork");
}
