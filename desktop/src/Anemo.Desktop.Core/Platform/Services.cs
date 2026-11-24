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

/// <summary>The names of <c>device.offer.shell_kind</c> (device-contracts.md §2).</summary>
public static class ShellKinds
{
    public const string PowerShell = "powershell";
    public const string Pwsh = "pwsh";
    public const string Zsh = "zsh";
    public const string Bash = "bash";

    /// <summary>The kind of the shell program at this path, from its file name (pwsh.exe → pwsh).</summary>
    public static string FromPath(string path)
    {
        var name = Path.GetFileNameWithoutExtension(path.Replace('\\', '/').Split('/')[^1]).ToLowerInvariant();
        return name switch
        {
            "pwsh" => Pwsh,
            "zsh" => Zsh,
            "bash" => Bash,
            _ => PowerShell,
        };
    }

    public static bool IsPowerShell(string kind) => kind is PowerShell or Pwsh;
}

/// <summary>The shell <c>shell</c> runs in: its program and its kind (<see cref="ShellKinds"/>).</summary>
public sealed record ShellProgram(string Path, string Kind)
{
    public static ShellProgram At(string path) => new(path, ShellKinds.FromPath(path));
}

public interface IShellHost
{
    /// <summary>
    /// The shell to run commands in: on Windows pwsh when installed, else Windows PowerShell
    /// 5.1; on macOS zsh, else bash. Null when none is found.
    /// </summary>
    ShellProgram? FindShell();

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
