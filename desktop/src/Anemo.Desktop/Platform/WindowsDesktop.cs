using System;
using System.Collections.Generic;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using Anemo.Desktop.Core.Platform;

namespace Anemo.Desktop.Platform;

/// <summary><see cref="IDesktop"/> on Windows: Win32 windows, GDI captures, UI Automation.</summary>
internal sealed class WindowsDesktop : IDesktop
{
    /// <summary>
    /// The secure desktop (UAC prompt, lock screen, Ctrl+Alt+Del screen) is "Winlogon";
    /// a normal process can't even open it. Only "Default" is the user's desktop.
    /// </summary>
    public bool IsSecureDesktop()
    {
        var desktop = Win32.OpenInputDesktop(0, false, Win32.DesktopReadObjects);
        if (desktop == IntPtr.Zero)
        {
            return true;
        }

        try
        {
            var name = new StringBuilder(256);
            return !Win32.GetUserObjectInformation(desktop, Win32.UoiName, name, name.Capacity * 2, out _)
                || !string.Equals(name.ToString(), "Default", StringComparison.OrdinalIgnoreCase);
        }
        finally
        {
            Win32.CloseDesktop(desktop);
        }
    }

    public IReadOnlyList<WindowInfo> ListWindows() => Windows.List();

    public WindowInfo? FrontWindow() => Windows.Front();

    public WindowInfo? FindWindow(long handle) => Windows.IsOwn(new IntPtr(handle)) ? null : Windows.Info(new IntPtr(handle));

    public void FocusWindow(long handle) => Windows.Focus(new IntPtr(handle));

    public ScreenRect VirtualScreen() => ScreenCapturer.VirtualScreen();

    public ScreenCapture CaptureScreen() => ScreenCapturer.Screen();

    public ScreenCapture CaptureWindow(long handle) => ScreenCapturer.Window(new IntPtr(handle));

    public UiTree ReadTree(long windowHandle, CancellationToken ct) => UiaTree.Read(new IntPtr(windowHandle), ct);

    public IUiElement? FocusedElement()
    {
        try
        {
            var focused = AutomationElement.FocusedElement;
            return focused is null ? null : new UiaElement(focused);
        }
        catch (ElementNotAvailableException)
        {
            return null;
        }
    }

    public bool IsOwnWindowAt(ScreenPoint point) =>
        Windows.IsOwn(Win32.WindowFromPoint(new Win32.Point { X = point.X, Y = point.Y }));

    public bool IsOwnWindowInFront() => Windows.IsOwn(Win32.GetForegroundWindow());
}
