using Anemo.Desktop.Core.Commands;

namespace Anemo.Desktop.Core.Platform;

/// <summary>Mouse and keyboard (SendInput in the app).</summary>
public interface IInput
{
    void Click(ScreenPoint at, MouseButton button, int count);

    /// <summary>Types the text where the focus is; stops between characters when cancelled.</summary>
    void TypeText(string text, CancellationToken ct);

    void Press(KeyCombo combo);

    /// <summary>Wheel at a point (or where the pointer is when null).</summary>
    void Scroll(ScreenPoint? at, ScrollDirection direction, int amount);
}

public interface IClipboard
{
    void SetText(string text);
}

/// <summary>A program in the Start menu: its display name and what starts it.</summary>
public sealed record StartMenuApp(string Name, string LaunchId);

public interface IAppLauncher
{
    IReadOnlyList<StartMenuApp> ListApps();

    void Launch(StartMenuApp app);

    /// <summary>Opens an http(s) URL in the default browser.</summary>
    void OpenUrl(Uri url);
}

/// <summary>A program to start for <c>shell</c>, hidden, with its output read.</summary>
public sealed record ShellStart(string FileName, IReadOnlyList<string> Arguments, string WorkingDirectory);

public interface IShellHost
{
    /// <summary>pwsh when installed, else Windows PowerShell 5.1; null when neither is found.</summary>
    string? FindPowerShell();

    /// <summary>
    /// Runs the program to its end and returns its exit code. Cancelling the token kills it
    /// (with its children) and throws <see cref="OperationCanceledException"/>.
    /// </summary>
    Task<int> RunAsync(ShellStart start, Action<string> onStdout, Action<string> onStderr, CancellationToken ct);

    /// <summary>Makes sure the working folder exists.</summary>
    void EnsureFolder(string path);
}

/// <summary>Protects the device token for the current user (DPAPI in the app).</summary>
public interface ITokenProtector
{
    string Protect(string token);

    /// <summary>The token, or null when it can't be read back (another user, another machine).</summary>
    string? Unprotect(string protectedToken);
}

/// <summary>Every platform service the command handlers use.</summary>
public sealed record PlatformServices(
    IDesktop Desktop,
    IInput Input,
    IClipboard Clipboard,
    IAppLauncher Apps,
    IShellHost Shell);
