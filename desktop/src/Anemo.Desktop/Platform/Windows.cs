using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using Anemo.Desktop.Core.Platform;

namespace Anemo.Desktop.Platform;

/// <summary>Top-level windows: which ones a person would call "open windows", and facts about them.</summary>
internal static class Windows
{
    private static readonly HashSet<string> ShellClasses = new(StringComparer.Ordinal)
    {
        "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Progman", "WorkerW", "NotifyIconOverflowWindow",
        "Windows.UI.Core.CoreWindow", "XamlExplorerHostIslandWindow",
    };

    private static readonly uint OwnProcessId = (uint)Environment.ProcessId;

    /// <summary>The user's windows, front first.</summary>
    public static List<WindowInfo> List()
    {
        var result = new List<WindowInfo>();
        Win32.EnumWindows((hwnd, _) =>
        {
            if (IsUserWindow(hwnd) && Info(hwnd) is { } info)
            {
                result.Add(info);
            }

            return true;
        }, IntPtr.Zero);
        return result;
    }

    public static WindowInfo? Front()
    {
        var foreground = Win32.GetForegroundWindow();
        if (foreground != IntPtr.Zero)
        {
            var root = Win32.GetAncestor(foreground, Win32.GaRoot);
            if (IsUserWindow(root) && !Win32.IsIconic(root))
            {
                return Info(root);
            }
        }

        // The taskbar or the tray menu is in front: the window the user worked in is the
        // topmost of the others.
        return List().Find(w => !w.Minimized);
    }

    public static WindowInfo? Info(IntPtr hwnd)
    {
        if (!Win32.IsWindow(hwnd))
        {
            return null;
        }

        var length = Win32.GetWindowTextLength(hwnd);
        var title = new StringBuilder(Math.Max(length + 1, 2));
        Win32.GetWindowText(hwnd, title, title.Capacity);
        return new WindowInfo(hwnd.ToInt64(), title.ToString(), AppName(hwnd), Win32.IsIconic(hwnd), Bounds(hwnd));
    }

    /// <summary>The window's visible bounds (without the invisible resize border).</summary>
    public static ScreenRect Bounds(IntPtr hwnd)
    {
        if (Win32.DwmGetWindowAttribute(hwnd, Win32.DwmwaExtendedFrameBounds, out Win32.Rect r, 16) != 0)
        {
            Win32.GetWindowRect(hwnd, out r);
        }

        return new ScreenRect(r.Left, r.Top, Math.Max(0, r.Right - r.Left), Math.Max(0, r.Bottom - r.Top));
    }

    public static bool IsOwn(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero)
        {
            return false;
        }

        Win32.GetWindowThreadProcessId(Win32.GetAncestor(hwnd, Win32.GaRoot), out var pid);
        return pid == OwnProcessId;
    }

    private static bool IsUserWindow(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero || !Win32.IsWindowVisible(hwnd) || Win32.GetWindowTextLength(hwnd) == 0 || IsOwn(hwnd))
        {
            return false;
        }

        if (Win32.DwmGetWindowAttribute(hwnd, Win32.DwmwaCloaked, out int cloaked, 4) == 0 && cloaked != 0)
        {
            return false; // on another virtual desktop, or a suspended store app
        }

        var exStyle = Win32.GetWindowLongPtr(hwnd, Win32.GwlExStyle).ToInt64();
        var appWindow = (exStyle & Win32.WsExAppWindow) != 0;
        if (!appWindow && ((exStyle & Win32.WsExToolWindow) != 0 || Win32.GetWindow(hwnd, Win32.GwOwner) != IntPtr.Zero))
        {
            return false;
        }

        var cls = new StringBuilder(256);
        Win32.GetClassName(hwnd, cls, cls.Capacity);
        return !ShellClasses.Contains(cls.ToString());
    }

    private static string AppName(IntPtr hwnd)
    {
        Win32.GetWindowThreadProcessId(hwnd, out var pid);
        var process = Win32.OpenProcess(Win32.ProcessQueryLimitedInformation, false, pid);
        if (process == IntPtr.Zero)
        {
            return "";
        }

        try
        {
            var size = 1024;
            var path = new StringBuilder(size);
            return Win32.QueryFullProcessImageName(process, 0, path, ref size) ? Path.GetFileName(path.ToString()) : "";
        }
        finally
        {
            Win32.CloseHandle(process);
        }
    }

    /// <summary>
    /// Brings a window to the front. Windows lets a background process do that only after
    /// some input, so an Alt press is sent first when the plain call is refused.
    /// </summary>
    public static void Focus(IntPtr hwnd)
    {
        if (Win32.IsIconic(hwnd))
        {
            Win32.ShowWindow(hwnd, Win32.SwRestore);
        }

        if (Win32.SetForegroundWindow(hwnd))
        {
            return;
        }

        SendInputDevice.TapAlt();
        if (!Win32.SetForegroundWindow(hwnd))
        {
            Debug.WriteLine("SetForegroundWindow was refused");
        }
    }
}
