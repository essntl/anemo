using System;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace Anemo.Desktop.Platform;

/// <summary>
/// The Windows light/dark setting, and the DWM attributes that round a window's corners and
/// colour its border on Windows 11 (they do nothing on Windows 10).
/// </summary>
internal static class WindowsTheme
{
    private const string Personalize = @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";
    private const int DwmwaUseImmersiveDarkMode = 20;
    private const int DwmwaWindowCornerPreference = 33;
    private const int DwmwaBorderColor = 34;

    /// <summary>Forces light (false) or dark (true) instead of the Windows setting, e.g. to render previews.</summary>
    public static bool? Override { get; set; }

    /// <summary>Apps are dark (Settings → Personalisation → Colours → app mode).</summary>
    public static bool AppsAreDark => Override ?? ReadLight("AppsUseLightTheme") == 0;

    /// <summary>The taskbar and its menus are dark (Windows mode).</summary>
    public static bool TaskbarIsDark => Override ?? ReadLight("SystemUsesLightTheme") == 0;

    /// <summary>Windows 11: DWM rounds and colours borders. Windows 10 ignores both.</summary>
    public static bool HasRoundedWindows => Environment.OSVersion.Version.Build >= 22000;

    public enum Corners
    {
        Default = 0,
        Square = 1,
        Round = 2,
        RoundSmall = 3,
    }

    public static void SetCorners(IntPtr window, Corners corners)
    {
        var value = (int)corners;
        _ = DwmSetWindowAttribute(window, DwmwaWindowCornerPreference, ref value, sizeof(int));
    }

    /// <summary>The 1 px border DWM draws around a window, as #RRGGBB.</summary>
    public static void SetBorderColor(IntPtr window, byte r, byte g, byte b)
    {
        var colorRef = r | (g << 8) | (b << 16);
        _ = DwmSetWindowAttribute(window, DwmwaBorderColor, ref colorRef, sizeof(int));
    }

    /// <summary>Dark system parts (the border, the Alt+Tab preview frame) for a dark window.</summary>
    public static void SetDarkFrame(IntPtr window, bool dark)
    {
        var value = dark ? 1 : 0;
        _ = DwmSetWindowAttribute(window, DwmwaUseImmersiveDarkMode, ref value, sizeof(int));
    }

    private static int ReadLight(string name)
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(Personalize);
            return key?.GetValue(name) is int value ? value : 1;
        }
        catch (Exception e) when (e is System.Security.SecurityException or UnauthorizedAccessException)
        {
            return 1;
        }
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
}
