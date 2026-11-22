namespace Anemo.Desktop.Core.Platform;

/// <summary>A rectangle in physical screen pixels.</summary>
public readonly record struct ScreenRect(int X, int Y, int Width, int Height)
{
    public ScreenPoint Center => new(X + Width / 2, Y + Height / 2);
}

/// <summary>A point in physical screen pixels.</summary>
public readonly record struct ScreenPoint(int X, int Y);

/// <summary>A top-level window. <see cref="Handle"/> is the HWND.</summary>
public sealed record WindowInfo(long Handle, string Title, string App, bool Minimized, ScreenRect Bounds);

/// <summary>
/// A screenshot already scaled to at most <see cref="ScreenshotScaler.MaxSide"/> pixels on
/// its long side. Screen point = origin + screenshot pixel × scale.
/// </summary>
public sealed record ScreenCapture(byte[] Png, int Width, int Height, double Scale, int OriginX, int OriginY);

/// <summary>Windows, the UI Automation tree and screenshots (the app implements it).</summary>
public interface IDesktop
{
    /// <summary>True while Windows shows the secure desktop (UAC prompt, lock screen).</summary>
    bool IsSecureDesktop();

    /// <summary>The visible top-level windows, front first, not counting Anemo Desktop's own.</summary>
    IReadOnlyList<WindowInfo> ListWindows();

    /// <summary>The window the user works in (the foreground one, else the topmost of <see cref="ListWindows"/>).</summary>
    WindowInfo? FrontWindow();

    /// <summary>The window, if it still exists.</summary>
    WindowInfo? FindWindow(long handle);

    void FocusWindow(long handle);

    /// <summary>The whole virtual screen (every monitor).</summary>
    ScreenRect VirtualScreen();

    ScreenCapture CaptureScreen();

    ScreenCapture CaptureWindow(long handle);

    /// <summary>The window's UI Automation tree in document order.</summary>
    UiTree ReadTree(long windowHandle, CancellationToken ct);

    /// <summary>The control that has the keyboard focus, if any.</summary>
    IUiElement? FocusedElement();
}

/// <summary>One node of the UI Automation tree.</summary>
public sealed record UiNode(
    int Depth,
    string Role,
    string? Name,
    string? Value,
    bool Enabled,
    bool Password,
    bool Interactive,
    IUiElement? Element);

/// <summary>The nodes of a window; <see cref="Truncated"/> when the walk stopped early.</summary>
public sealed record UiTree(IReadOnlyList<UiNode> Nodes, bool Truncated);

/// <summary>
/// A control found by UI Automation. Every member throws <see cref="ElementGoneException"/>
/// when the control no longer exists.
/// </summary>
public interface IUiElement
{
    bool IsPassword { get; }

    bool IsEnabled { get; }

    /// <summary>Invoke (or expand/collapse) the control without the mouse; false when it has no such pattern.</summary>
    bool TryInvoke();

    /// <summary>Set the text with the Value pattern; false when it has none or is read-only.</summary>
    bool TrySetValue(string text);

    /// <summary>Scroll with the Scroll pattern; false when it has none.</summary>
    bool TryScroll(ScrollDirection direction, int amount);

    /// <summary>Bring the control's window to the front and give the point to click on.</summary>
    ScreenPoint PrepareForMouse();

    void Focus();
}

/// <summary>The control a ref pointed to is gone.</summary>
public sealed class ElementGoneException : Exception
{
    public ElementGoneException() : base("The control is gone.") { }

    public ElementGoneException(Exception inner) : base("The control is gone.", inner) { }
}

public enum ScrollDirection
{
    Up,
    Down,
    Left,
    Right,
}

public enum MouseButton
{
    Left,
    Right,
}
