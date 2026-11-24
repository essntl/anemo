using Anemo.Desktop.Core.Commands;
using Anemo.Desktop.Core.Platform;
using Anemo.Desktop.Mac.Native;

namespace Anemo.Desktop.Mac.Platform;

/// <summary>
/// Windows, their controls and screenshots on macOS (Core's <see cref="IDesktop"/>). Windows come
/// from CGWindowList (handle = CGWindowID), controls from Accessibility, screenshots from
/// ScreenCaptureKit. Every rectangle is in points (docs/specs/09-desktop-macos.md D4).
/// </summary>
internal sealed class MacDesktop : IDesktop
{
    /// <summary>
    /// Apps whose windows the agent never looks at or acts on: System Settings (where the
    /// permissions are granted), permission and password prompts, the login window.
    /// </summary>
    private static readonly HashSet<string> ProtectedApps = new(StringComparer.Ordinal)
    {
        "com.apple.systempreferences", "com.apple.Settings", "com.apple.loginwindow", "com.apple.SecurityAgent",
        "com.apple.UserNotificationCenter", "com.apple.accessibility.universalAccessAuthWarn", "com.apple.CoreServicesUIAgent",
    };

    private static readonly HashSet<string> ProtectedOwners = new(StringComparer.Ordinal)
    {
        "SecurityAgent", "UserNotificationCenter", "universalAccessAuthWarn", "loginwindow", "CoreServicesUIAgent",
    };

    private readonly int _ownPid = Environment.ProcessId;

    public bool IsSecureDesktop()
    {
        if (IsLocked())
        {
            return true;
        }

        if (MacApps.Frontmost() is { } front && front.BundleId is { } bundle && ProtectedApps.Contains(bundle))
        {
            return true;
        }

        // A prompt can be on top while another app is "frontmost".
        return WindowList.Read(onScreenOnly: true).Any(w => w.Layer >= 0 && ProtectedOwners.Contains(w.Owner) && w.Bounds.Width > 0);
    }

    public IReadOnlyList<WindowInfo> ListWindows() =>
        WindowList.Read(onScreenOnly: false)
            .Where(w => w.Layer == 0 && w.Pid != _ownPid && w.Bounds.Width >= 40 && w.Bounds.Height >= 40 && (w.OnScreen || w.Title.Length > 0))
            .Select(w => w.ToInfo())
            .ToList();

    public WindowInfo? FrontWindow()
    {
        var windows = WindowList.Read(onScreenOnly: true).Where(w => w.Layer == 0 && w.Pid != _ownPid && w.Bounds.Width >= 40).ToList();
        var frontPid = MacApps.Frontmost()?.Pid;
        var front = windows.FirstOrDefault(w => w.Pid == frontPid) ?? windows.FirstOrDefault();
        return front?.ToInfo();
    }

    public WindowInfo? FindWindow(long handle) =>
        WindowList.Read(onScreenOnly: false).FirstOrDefault(w => w.Id == handle)?.ToInfo();

    public void FocusWindow(long handle)
    {
        var window = WindowList.Read(onScreenOnly: false).FirstOrDefault(w => w.Id == handle) ?? throw new ElementGoneException();
        MacApps.Activate(window.Pid);
        var ax = AxWindow(window);
        if (ax == 0)
        {
            return; // the app is in front; without Accessibility the window itself can't be raised
        }

        try
        {
            if (AX.Bool(ax, "AXMinimized") == true)
            {
                AX.SetBool(ax, "AXMinimized", false);
            }

            AX.Perform(ax, "AXRaise");
            AX.SetBool(ax, "AXMain", true);
        }
        finally
        {
            CF.Release(ax);
        }
    }

    public ScreenRect VirtualScreen() => DisplayLayout.Union(ScreenCapturer.Displays());

    public Core.Platform.ScreenCapture CaptureScreen() => ScreenCapturer.CaptureScreen();

    public Core.Platform.ScreenCapture CaptureWindow(long handle)
    {
        var window = WindowList.Read(onScreenOnly: false).FirstOrDefault(w => w.Id == handle) ?? throw new ElementGoneException();
        return ScreenCapturer.CaptureWindow((uint)window.Id, window.Bounds);
    }

    public UiTree ReadTree(long windowHandle, CancellationToken ct)
    {
        if (!AX.IsTrusted())
        {
            return new UiTree([], false); // Core says the window has no controls; Permissions explains why
        }

        var window = WindowList.Read(onScreenOnly: false).FirstOrDefault(w => w.Id == windowHandle);
        var ax = window is null ? 0 : AxWindow(window);
        if (ax == 0)
        {
            return new UiTree([], false);
        }

        try
        {
            return AxTree.Read(ax, ct);
        }
        finally
        {
            CF.Release(ax);
        }
    }

    public IUiElement? FocusedElement()
    {
        if (!AX.IsTrusted())
        {
            return null; // Core then refuses to type ("can't tell which control has the focus")
        }

        var system = AX.SystemWide();
        try
        {
            var focused = AX.Element(system, "AXFocusedUIElement");
            if (focused == 0)
            {
                return null;
            }

            // While macOS has Secure Event Input on, a password field has the keyboard somewhere.
            return Carbon.SecureInputEnabled() ? new SecureInputElement(new AxElement(focused)) : new AxElement(focused);
        }
        finally
        {
            CF.Release(system);
        }
    }

    public bool IsOwnWindowAt(ScreenPoint point)
    {
        var top = WindowList.Read(onScreenOnly: true).FirstOrDefault(w =>
            w.Layer < 1000 && point.X >= w.Bounds.X && point.X < w.Bounds.X + w.Bounds.Width
            && point.Y >= w.Bounds.Y && point.Y < w.Bounds.Y + w.Bounds.Height);
        return top is not null && top.Pid == _ownPid;
    }

    public bool IsOwnWindowInFront() => MacApps.Frontmost()?.Pid == _ownPid;

    /// <summary>The screen is locked or another user's session is on the screen.</summary>
    private static bool IsLocked()
    {
        var session = CG.SessionDictionary();
        if (session == 0)
        {
            return true; // no window server session at all: nothing can be seen
        }

        try
        {
            var locked = CF.ToBool(CF.Get(session, "CGSSessionScreenIsLocked")) == true;
            var onConsole = CF.ToBool(CF.Get(session, "kCGSSessionOnConsoleKey")) != false;
            return locked || !onConsole;
        }
        finally
        {
            CF.Release(session);
        }
    }

    /// <summary>
    /// The Accessibility element of a CGWindow: the app's window with the same frame (and title
    /// when it has one). Retained (release it), or 0.
    /// </summary>
    private static nint AxWindow(WindowList.Entry window)
    {
        var app = AX.Application(window.Pid);
        try
        {
            AX.SetTimeout(app, 2);
            nint found = 0;
            foreach (var candidate in AX.Elements(app, "AXWindows"))
            {
                if (found == 0 && AX.Frame(candidate)?.ToScreenRect() is { } frame && Near(frame, window.Bounds)
                    && (window.Title.Length == 0 || AX.Text(candidate, "AXTitle") == window.Title))
                {
                    found = candidate;
                }
                else
                {
                    CF.Release(candidate);
                }
            }

            return found;
        }
        finally
        {
            CF.Release(app);
        }
    }

    private static bool Near(ScreenRect a, ScreenRect b) =>
        Math.Abs(a.X - b.X) <= 2 && Math.Abs(a.Y - b.Y) <= 2 && Math.Abs(a.Width - b.Width) <= 2 && Math.Abs(a.Height - b.Height) <= 2;
}

/// <summary>The focused control while Secure Event Input is on: counts as a password field.</summary>
internal sealed class SecureInputElement(AxElement inner) : IUiElement
{
    public bool IsPassword => true;

    public bool IsEnabled => inner.IsEnabled;

    public bool TryInvoke() => inner.TryInvoke();

    public bool TrySetValue(string text) => false;

    public bool TryScroll(ScrollDirection direction, int amount) => false;

    public ScreenPoint PrepareForMouse() => inner.PrepareForMouse();

    public void Focus() => inner.Focus();
}

/// <summary>The window list of the window server (CGWindowListCopyWindowInfo), front first.</summary>
internal static class WindowList
{
    public sealed record Entry(long Id, int Pid, string Owner, string Title, int Layer, bool OnScreen, ScreenRect Bounds)
    {
        public WindowInfo ToInfo() => new(Id, Title, Owner, !OnScreen, Bounds);
    }

    public static List<Entry> Read(bool onScreenOnly)
    {
        var list = new List<Entry>();
        var array = CG.WindowList(onScreenOnly ? CG.OnScreenOnly | CG.ExcludeDesktopElements : CG.OptionAll | CG.ExcludeDesktopElements, 0);
        if (array == 0)
        {
            return list;
        }

        try
        {
            var count = CF.ArrayCount(array);
            for (nint i = 0; i < count; i++)
            {
                var info = CF.ArrayAt(array, i);
                var bounds = CG.RectFromDictionary(CF.Get(info, "kCGWindowBounds"), out var rect) ? rect.ToScreenRect() : default;
                list.Add(new Entry(
                    CF.ToLong(CF.Get(info, "kCGWindowNumber")) ?? 0,
                    CF.ToInt(CF.Get(info, "kCGWindowOwnerPID")) ?? 0,
                    CF.ToText(CF.Get(info, "kCGWindowOwnerName")) ?? "",
                    CF.ToText(CF.Get(info, "kCGWindowName")) ?? "", // needs Screen Recording
                    CF.ToInt(CF.Get(info, "kCGWindowLayer")) ?? 0,
                    CF.ToBool(CF.Get(info, "kCGWindowIsOnscreen")) ?? false,
                    bounds));
            }

            return list;
        }
        finally
        {
            CF.Release(array);
        }
    }
}
