using System.Diagnostics;
using Anemo.Desktop.Mac.Native;

namespace Anemo.Desktop.Mac.Platform;

/// <summary>
/// The two permissions computer use needs (docs/specs/09-desktop-macos.md D7). Checking never
/// asks; asking shows macOS's own prompt; only the user can switch them on, in System Settings.
/// The app never edits the permission database or scripts System Settings.
/// </summary>
internal static class Permissions
{
    private const string ScreenRecordingPane = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
    private const string AccessibilityPane = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

    public static bool ScreenRecording => CG.PreflightScreenCapture();

    public static bool Accessibility => AX.IsTrusted();

    public static bool AllGranted => ScreenRecording && Accessibility;

    /// <summary>A command needed a permission that is missing (the menu bar app shows the Permissions window).</summary>
    public static event Action? Missing;

    public static void ReportMissing() => Missing?.Invoke();

    /// <summary>macOS's prompt for Screen Recording (shown once per app; afterwards only System Settings).</summary>
    public static void AskScreenRecording() => CG.RequestScreenCapture();

    /// <summary>macOS's prompt that leads to Accessibility in System Settings.</summary>
    public static void AskAccessibility() => AX.AskForTrust();

    public static void OpenScreenRecordingSettings() => Open(ScreenRecordingPane);

    public static void OpenAccessibilitySettings() => Open(AccessibilityPane);

    private static void Open(string url)
    {
        var info = new ProcessStartInfo("/usr/bin/open") { UseShellExecute = false };
        info.ArgumentList.Add(url);
        using var _ = Process.Start(info);
    }
}

/// <summary>"Open at login" with SMAppService (macOS 13+): the app itself as a login item.</summary>
internal static class LoginItem
{
    private const long Enabled = 1; // SMAppServiceStatusEnabled
    private const long RequiresApproval = 2; // SMAppServiceStatusRequiresApproval

    private static nint MainApp() => ObjC.Call(ObjC.Class("SMAppService"), "mainAppService");

    public static bool IsOn => ObjC.InPool(() => ObjC.SendReturnLong(MainApp(), ObjC.Selector("status")) is Enabled or RequiresApproval);

    /// <summary>True when macOS asks the user to approve it in System Settings → General → Login Items.</summary>
    public static bool NeedsApproval => ObjC.InPool(() => ObjC.SendReturnLong(MainApp(), ObjC.Selector("status")) == RequiresApproval);

    /// <summary>Registers or unregisters; false (with nothing changed) when macOS refused, e.g. for an app not in /Applications.</summary>
    public static bool Set(bool on) => ObjC.InPool(() =>
    {
        var app = MainApp();
        if ((ObjC.SendReturnLong(app, ObjC.Selector("status")) is Enabled or RequiresApproval) == on)
        {
            return true;
        }

        return ObjC.SendBool(app, ObjC.Selector(on ? "registerAndReturnError:" : "unregisterAndReturnError:"), 0);
    });
}
