using Anemo.Desktop.Core.Commands;
using Anemo.Desktop.Core.Platform;

namespace Anemo.Desktop.Tests.Fakes;

/// <summary>A control in the fake UI Automation tree; records what was done to it.</summary>
public sealed class FakeElement : IUiElement
{
    public bool Gone { get; set; }

    public bool Password { get; init; }

    public bool Enabled { get; init; } = true;

    public bool CanInvoke { get; init; } = true;

    public bool CanSetValue { get; init; } = true;

    public bool CanScroll { get; init; }

    public ScreenPoint Point { get; init; } = new(500, 300);

    public List<string> Calls { get; } = [];

    public FakeDesktop? Desktop { get; init; }

    public bool IsPassword => Check(Password);

    public bool IsEnabled => Check(Enabled);

    public bool TryInvoke()
    {
        Check(true);
        Calls.Add("invoke");
        return CanInvoke;
    }

    public bool TrySetValue(string text)
    {
        Check(true);
        Calls.Add("set_value:" + text);
        return CanSetValue;
    }

    public bool TryScroll(ScrollDirection direction, int amount)
    {
        Check(true);
        Calls.Add($"scroll:{direction}:{amount}");
        return CanScroll;
    }

    public ScreenPoint PrepareForMouse()
    {
        Check(true);
        Calls.Add("prepare");
        return Point;
    }

    public void Focus()
    {
        Check(true);
        Calls.Add("focus");
        if (Desktop is not null)
        {
            Desktop.Focused = this;
        }
    }

    private bool Check(bool value) => Gone ? throw new ElementGoneException() : value;
}

public sealed class FakeDesktop : IDesktop
{
    public bool Secure { get; set; }

    public List<WindowInfo> Windows { get; } =
    [
        new WindowInfo(1001, "Book1 - Excel", "EXCEL.EXE", false, new ScreenRect(100, 50, 1600, 1000)),
        new WindowInfo(1002, "Notes - Notepad", "notepad.exe", false, new ScreenRect(0, 0, 800, 600)),
        new WindowInfo(1003, "Downloads", "explorer.exe", true, new ScreenRect(0, 0, 800, 600)),
    ];

    public long FrontHandle { get; set; } = 1001;

    public ScreenRect Screen { get; set; } = new(0, 0, 3136, 1764);

    /// <summary>The scale and origin the captures report.</summary>
    public double CaptureScale { get; set; } = 2.0;

    public Func<long, UiTree> Tree { get; set; } = _ => new UiTree([], false);

    public IUiElement? Focused { get; set; }

    public List<string> Calls { get; } = [];

    public static byte[] Png { get; } = [0x89, 0x50, 0x4E, 0x47, 1, 2, 3];

    public bool IsSecureDesktop() => Secure;

    public IReadOnlyList<WindowInfo> ListWindows() => Windows;

    public WindowInfo? FrontWindow() => Windows.FirstOrDefault(w => w.Handle == FrontHandle);

    public WindowInfo? FindWindow(long handle) => Windows.FirstOrDefault(w => w.Handle == handle);

    public void FocusWindow(long handle)
    {
        Calls.Add($"focus_window:{handle}");
        FrontHandle = handle;
    }

    public ScreenRect VirtualScreen() => Screen;

    public ScreenCapture CaptureScreen()
    {
        Calls.Add("capture_screen");
        return new ScreenCapture(Png, (int)(Screen.Width / CaptureScale), (int)(Screen.Height / CaptureScale), CaptureScale, Screen.X, Screen.Y);
    }

    public ScreenCapture CaptureWindow(long handle)
    {
        Calls.Add($"capture_window:{handle}");
        var b = FindWindow(handle)!.Bounds;
        return new ScreenCapture(Png, (int)(b.Width / CaptureScale), (int)(b.Height / CaptureScale), CaptureScale, b.X, b.Y);
    }

    public UiTree ReadTree(long windowHandle, CancellationToken ct) => Tree(windowHandle);

    public IUiElement? FocusedElement() => Focused;

    /// <summary>Where Anemo Desktop's own window is (settings or indicator), if shown.</summary>
    public ScreenRect? OwnWindow { get; set; }

    public bool OwnWindowInFront { get; set; }

    public bool IsOwnWindowAt(ScreenPoint point) =>
        OwnWindow is { } r && point.X >= r.X && point.Y >= r.Y && point.X < r.X + r.Width && point.Y < r.Y + r.Height;

    public bool IsOwnWindowInFront() => OwnWindowInFront;
}

public sealed class FakeInput : IInput
{
    public List<string> Events { get; } = [];

    /// <summary>Called for each typed character (to stop in the middle of typing in a test).</summary>
    public Action<int>? OnTypedChar { get; set; }

    public void Click(ScreenPoint at, MouseButton button, int count) => Events.Add($"click:{at.X},{at.Y}:{button}:{count}");

    public void TypeText(string text, CancellationToken ct)
    {
        for (var i = 0; i < text.Length; i++)
        {
            ct.ThrowIfCancellationRequested();
            OnTypedChar?.Invoke(i);
        }

        Events.Add("type:" + text);
    }

    public void Press(KeyCombo combo) =>
        Events.Add($"press:{string.Join("+", combo.Modifiers.Select(m => m.ToString("X2")))}|{combo.Key:X2}");

    public void Scroll(ScreenPoint? at, ScrollDirection direction, int amount) =>
        Events.Add($"scroll:{at?.X},{at?.Y}:{direction}:{amount}");
}

public sealed class FakeClipboard : IClipboard
{
    public string? Text { get; private set; }

    public void SetText(string text) => Text = text;
}

public sealed class FakeApps : IAppLauncher
{
    public List<StartMenuApp> Apps { get; } =
    [
        new("Excel", "Microsoft.Office.EXCEL.EXE.15"),
        new("Notepad", "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App"),
        new("Notepad++", @"C:\Program Files\Notepad++\notepad++.exe"),
        new("Calculator", "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"),
        new("Visual Studio Code", "Microsoft.VisualStudioCode"),
        new("Visual Studio 2022", "VisualStudio.17"),
    ];

    public List<string> Launched { get; } = [];

    public IReadOnlyList<StartMenuApp> ListApps() => Apps;

    public void Launch(StartMenuApp app) => Launched.Add(app.LaunchId);

    public void OpenUrl(Uri url) => Launched.Add(url.ToString());
}

public sealed class FakeShell : IShellHost
{
    public string? Program { get; set; } = @"C:\Program Files\PowerShell\7\pwsh.exe";

    public List<ShellStart> Started { get; } = [];

    public List<string> Folders { get; } = [];

    /// <summary>What the "process" does: write output, return the exit code, or wait to be cancelled.</summary>
    public Func<Action<string>, Action<string>, CancellationToken, Task<int>> Behaviour { get; set; } =
        (stdout, _, _) =>
        {
            stdout("hello");
            return Task.FromResult(0);
        };

    public string? FindPowerShell() => Program;

    public Task<int> RunAsync(ShellStart start, Action<string> onStdout, Action<string> onStderr, CancellationToken ct)
    {
        Started.Add(start);
        return Behaviour(onStdout, onStderr, ct);
    }

    public void EnsureFolder(string path) => Folders.Add(path);
}

/// <summary>A protector that is obviously not clear text, so tests can check the file.</summary>
public sealed class FakeProtector : Core.Platform.ITokenProtector
{
    public string Protect(string token) => "protected:" + Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(new string(token.Reverse().ToArray())));

    public string? Unprotect(string protectedToken) =>
        protectedToken.StartsWith("protected:", StringComparison.Ordinal)
            ? new string(System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(protectedToken["protected:".Length..])).Reverse().ToArray())
            : null;
}

/// <summary>Every fake platform service, ready to hand to a <see cref="CommandProcessor"/>.</summary>
public sealed class FakePlatform
{
    public FakeDesktop Desktop { get; } = new();

    public FakeInput Input { get; } = new();

    public FakeClipboard Clipboard { get; } = new();

    public FakeApps Apps { get; } = new();

    public FakeShell Shell { get; } = new();

    public PlatformServices Services => new(Desktop, Input, Clipboard, Apps, Shell);
}

/// <summary>A clock the tests move by hand.</summary>
public sealed class ManualTime : TimeProvider
{
    public DateTimeOffset Now { get; set; } = new(2026, 11, 22, 10, 0, 0, TimeSpan.Zero);

    public override DateTimeOffset GetUtcNow() => Now;
}

/// <summary>Keeps the diagnostic lines in memory.</summary>
public sealed class ListLog : Core.Storage.IDiagnosticLog
{
    public System.Collections.Concurrent.ConcurrentQueue<string> Lines { get; } = new();

    public void Info(string message) => Lines.Enqueue(message);
}
