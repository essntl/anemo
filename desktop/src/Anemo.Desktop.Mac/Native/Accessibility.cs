using System.Runtime.InteropServices;

namespace Anemo.Desktop.Mac.Native;

/// <summary>
/// The Accessibility API (HIServices, in ApplicationServices): reading another app's controls
/// and pressing them. Every call needs the Accessibility permission; without it they answer
/// <see cref="ApiDisabled"/>. Errors are AXError codes (0 = success).
/// </summary>
internal static partial class AX
{
    private const string Lib = "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices";

    public const int Success = 0;
    public const int InvalidElement = -25202; // kAXErrorInvalidUIElement: the control is gone
    public const int CannotComplete = -25204;
    public const int ApiDisabled = -25211; // no Accessibility permission
    public const int NoValue = -25212;

    // AXValueType
    private const int ValueCGPoint = 1;
    private const int ValueCGSize = 2;

    /// <summary>Accessibility is allowed for this app; never asks.</summary>
    [LibraryImport(Lib, EntryPoint = "AXIsProcessTrusted")]
    [return: MarshalAs(UnmanagedType.U1)]
    public static partial bool IsTrusted();

    [LibraryImport(Lib, EntryPoint = "AXIsProcessTrustedWithOptions")]
    [return: MarshalAs(UnmanagedType.U1)]
    private static partial bool AXIsProcessTrustedWithOptions(nint options);

    [LibraryImport(Lib, EntryPoint = "AXUIElementCreateSystemWide")]
    public static partial nint SystemWide();

    [LibraryImport(Lib, EntryPoint = "AXUIElementCreateApplication")]
    public static partial nint Application(int pid);

    [LibraryImport(Lib, EntryPoint = "AXUIElementCopyAttributeValue")]
    private static partial int AXUIElementCopyAttributeValue(nint element, nint attribute, out nint value);

    [LibraryImport(Lib, EntryPoint = "AXUIElementSetAttributeValue")]
    private static partial int AXUIElementSetAttributeValue(nint element, nint attribute, nint value);

    [LibraryImport(Lib, EntryPoint = "AXUIElementIsAttributeSettable")]
    private static partial int AXUIElementIsAttributeSettable(nint element, nint attribute, [MarshalAs(UnmanagedType.U1)] out bool settable);

    [LibraryImport(Lib, EntryPoint = "AXUIElementPerformAction")]
    private static partial int AXUIElementPerformAction(nint element, nint action);

    [LibraryImport(Lib, EntryPoint = "AXUIElementCopyActionNames")]
    private static partial int AXUIElementCopyActionNames(nint element, out nint names);

    [LibraryImport(Lib, EntryPoint = "AXUIElementGetPid")]
    public static partial int GetPid(nint element, out int pid);

    [LibraryImport(Lib, EntryPoint = "AXUIElementSetMessagingTimeout")]
    public static partial int SetTimeout(nint element, float seconds);

    [LibraryImport(Lib, EntryPoint = "AXValueGetValue")]
    [return: MarshalAs(UnmanagedType.U1)]
    private static partial bool AXValueGetValue(nint value, int type, out CGPoint point);

    [LibraryImport(Lib, EntryPoint = "AXValueGetValue")]
    [return: MarshalAs(UnmanagedType.U1)]
    private static partial bool AXValueGetValueSize(nint value, int type, out CGSize size);

    private static readonly nint Handle = NativeLibrary.Load(Lib);

    /// <summary>
    /// Asks macOS to let this app use Accessibility: macOS shows its own prompt, which leads
    /// to System Settings, where only the user can switch it on. True when allowed already.
    /// </summary>
    public static bool AskForTrust()
    {
        var key = CF.Constant(Handle, "kAXTrustedCheckOptionPrompt");
        var options = CF.Dictionary((key, CF.True));
        try
        {
            return AXIsProcessTrustedWithOptions(options);
        }
        finally
        {
            CF.Release(options);
        }
    }

    /// <summary>An attribute's value (release it), or 0 with the error.</summary>
    public static int Copy(nint element, string attribute, out nint value)
    {
        var name = CF.String(attribute);
        try
        {
            return AXUIElementCopyAttributeValue(element, name, out value);
        }
        finally
        {
            CF.Release(name);
        }
    }

    /// <summary>A string attribute (AXRole, AXTitle, …), or null.</summary>
    public static string? Text(nint element, string attribute)
    {
        if (Copy(element, attribute, out var value) != Success)
        {
            return null;
        }

        try
        {
            return CF.ToText(value);
        }
        finally
        {
            CF.Release(value);
        }
    }

    /// <summary>A value attribute as text (strings as they are, numbers and booleans written out).</summary>
    public static string? ValueText(nint element)
    {
        if (Copy(element, "AXValue", out var value) != Success)
        {
            return null;
        }

        try
        {
            return CF.ToText(value) ?? CF.ToDouble(value)?.ToString(System.Globalization.CultureInfo.InvariantCulture);
        }
        finally
        {
            CF.Release(value);
        }
    }

    public static bool? Bool(nint element, string attribute)
    {
        if (Copy(element, attribute, out var value) != Success)
        {
            return null;
        }

        try
        {
            return CF.ToBool(value);
        }
        finally
        {
            CF.Release(value);
        }
    }

    /// <summary>An element attribute (AXFocusedUIElement, AXFocusedWindow, …): release it.</summary>
    public static nint Element(nint element, string attribute) =>
        Copy(element, attribute, out var value) == Success ? value : 0;

    /// <summary>The elements of an array attribute (AXChildren, AXWindows), each retained: release each.</summary>
    public static List<nint> Elements(nint element, string attribute)
    {
        var list = new List<nint>();
        if (Copy(element, attribute, out var array) != Success)
        {
            return list;
        }

        try
        {
            if (CF.TypeOf(array) != CF.ArrayType())
            {
                return list;
            }

            var count = CF.ArrayCount(array);
            for (nint i = 0; i < count; i++)
            {
                list.Add(CF.Retain(CF.ArrayAt(array, i)));
            }

            return list;
        }
        finally
        {
            CF.Release(array);
        }
    }

    /// <summary>The element's frame in global points (AXPosition + AXSize), or null.</summary>
    public static CGRect? Frame(nint element)
    {
        if (Copy(element, "AXPosition", out var position) != Success)
        {
            return null;
        }

        try
        {
            if (Copy(element, "AXSize", out var size) != Success)
            {
                return null;
            }

            try
            {
                return AXValueGetValue(position, ValueCGPoint, out var p) && AXValueGetValueSize(size, ValueCGSize, out var s)
                    ? new CGRect(p.X, p.Y, s.Width, s.Height)
                    : null;
            }
            finally
            {
                CF.Release(size);
            }
        }
        finally
        {
            CF.Release(position);
        }
    }

    public static int SetText(nint element, string attribute, string text)
    {
        var name = CF.String(attribute);
        var value = CF.String(text);
        try
        {
            return AXUIElementSetAttributeValue(element, name, value);
        }
        finally
        {
            CF.Release(value);
            CF.Release(name);
        }
    }

    public static int SetBool(nint element, string attribute, bool on)
    {
        var name = CF.String(attribute);
        try
        {
            return AXUIElementSetAttributeValue(element, name, on ? CF.True : CF.False);
        }
        finally
        {
            CF.Release(name);
        }
    }

    public static bool Settable(nint element, string attribute)
    {
        var name = CF.String(attribute);
        try
        {
            return AXUIElementIsAttributeSettable(element, name, out var settable) == Success && settable;
        }
        finally
        {
            CF.Release(name);
        }
    }

    public static int Perform(nint element, string action)
    {
        var name = CF.String(action);
        try
        {
            return AXUIElementPerformAction(element, name);
        }
        finally
        {
            CF.Release(name);
        }
    }

    /// <summary>The actions the element supports (AXPress, AXShowMenu, …).</summary>
    public static HashSet<string> Actions(nint element)
    {
        var set = new HashSet<string>(StringComparer.Ordinal);
        if (AXUIElementCopyActionNames(element, out var names) != Success)
        {
            return set;
        }

        try
        {
            var count = CF.ArrayCount(names);
            for (nint i = 0; i < count; i++)
            {
                if (CF.ToText(CF.ArrayAt(names, i)) is { } name)
                {
                    set.Add(name);
                }
            }

            return set;
        }
        finally
        {
            CF.Release(names);
        }
    }
}
