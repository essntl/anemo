using System.Runtime.InteropServices;

namespace Anemo.Desktop.Mac.Native;

/// <summary>
/// Calling Objective-C from C#: classes and selectors by name, and <c>objc_msgSend</c> declared
/// once per argument shape it is called with. Every Objective-C call in this app goes through
/// here. On Apple Silicon (arm64) <c>objc_msgSend</c> is called like the C function it stands
/// for, also for methods that return a struct (there is no <c>_stret</c> variant on arm64);
/// an Intel build would need <c>objc_msgSend_stret</c> for the few that return a CGRect.
/// </summary>
internal static partial class ObjC
{
    private const string Lib = "/usr/lib/libobjc.A.dylib";

    [LibraryImport(Lib, EntryPoint = "objc_getClass", StringMarshalling = StringMarshalling.Utf8)]
    public static partial nint GetClass(string name);

    [LibraryImport(Lib, EntryPoint = "sel_registerName", StringMarshalling = StringMarshalling.Utf8)]
    public static partial nint Selector(string name);

    [LibraryImport(Lib, EntryPoint = "objc_autoreleasePoolPush")]
    public static partial nint PoolPush();

    [LibraryImport(Lib, EntryPoint = "objc_autoreleasePoolPop")]
    public static partial void PoolPop(nint pool);

    // objc_msgSend, by the shape of the call: receiver, selector, then the arguments.
    [LibraryImport(Lib, EntryPoint = "objc_msgSend")]
    public static partial nint Send(nint receiver, nint selector);

    [LibraryImport(Lib, EntryPoint = "objc_msgSend")]
    public static partial nint Send(nint receiver, nint selector, nint a);

    [LibraryImport(Lib, EntryPoint = "objc_msgSend")]
    public static partial nint Send(nint receiver, nint selector, nint a, nint b);

    [LibraryImport(Lib, EntryPoint = "objc_msgSend")]
    public static partial nint Send(nint receiver, nint selector, nint a, nint b, nint c);

    [LibraryImport(Lib, EntryPoint = "objc_msgSend")]
    public static partial nint SendLong(nint receiver, nint selector, long a);

    [LibraryImport(Lib, EntryPoint = "objc_msgSend")]
    public static partial nint SendUInt(nint receiver, nint selector, uint a);

    [LibraryImport(Lib, EntryPoint = "objc_msgSend")]
    [return: MarshalAs(UnmanagedType.U1)]
    public static partial bool SendBool(nint receiver, nint selector);

    [LibraryImport(Lib, EntryPoint = "objc_msgSend")]
    [return: MarshalAs(UnmanagedType.U1)]
    public static partial bool SendBool(nint receiver, nint selector, nint a);

    [LibraryImport(Lib, EntryPoint = "objc_msgSend")]
    [return: MarshalAs(UnmanagedType.U1)]
    public static partial bool SendBool(nint receiver, nint selector, nint a, nint b);

    [LibraryImport(Lib, EntryPoint = "objc_msgSend")]
    public static partial long SendReturnLong(nint receiver, nint selector);

    [LibraryImport(Lib, EntryPoint = "objc_msgSend")]
    public static partial uint SendReturnUInt(nint receiver, nint selector);

    [LibraryImport(Lib, EntryPoint = "objc_msgSend")]
    public static partial int SendReturnInt(nint receiver, nint selector);

    [LibraryImport(Lib, EntryPoint = "objc_msgSend")]
    public static partial double SendReturnDouble(nint receiver, nint selector);

    [LibraryImport(Lib, EntryPoint = "objc_msgSend")]
    public static partial CGRect SendReturnRect(nint receiver, nint selector);

    [LibraryImport(Lib, EntryPoint = "objc_msgSend")]
    public static partial void SendVoid(nint receiver, nint selector, nint a);

    [LibraryImport(Lib, EntryPoint = "objc_msgSend")]
    public static partial void SendVoid(nint receiver, nint selector, nint a, nint b);

    [LibraryImport(Lib, EntryPoint = "objc_msgSend")]
    public static partial void SendVoid(nint receiver, nint selector, nint a, nint b, nint c);

    [LibraryImport(Lib, EntryPoint = "objc_msgSend")]
    public static partial void SendVoidLong(nint receiver, nint selector, long a);

    [LibraryImport(Lib, EntryPoint = "objc_msgSend")]
    public static partial void SendVoidBool(nint receiver, nint selector, [MarshalAs(UnmanagedType.U1)] bool a);

    /// <summary>
    /// The frameworks whose classes the app uses; loading them registers their classes with the
    /// Objective-C runtime (Avalonia loads AppKit itself, the tests don't).
    /// </summary>
    private static readonly bool FrameworksLoaded = LoadFrameworks();

    private static bool LoadFrameworks()
    {
        foreach (var framework in new[] { "AppKit", "ScreenCaptureKit", "ServiceManagement" })
        {
            NativeLibrary.TryLoad($"/System/Library/Frameworks/{framework}.framework/{framework}", out _);
        }

        return true;
    }

    /// <summary><c>[Class name]</c>, failing loudly when the class doesn't exist (an older macOS).</summary>
    public static nint Class(string name)
    {
        _ = FrameworksLoaded;
        var cls = GetClass(name);
        return cls != 0 ? cls : throw new PlatformNotSupportedException($"The Objective-C class {name} isn't available on this macOS.");
    }

    /// <summary><c>[receiver selector]</c> by the selector's name, the most common call.</summary>
    public static nint Call(nint receiver, string selector) => Send(receiver, Selector(selector));

    public static nint Call(nint receiver, string selector, nint a) => Send(receiver, Selector(selector), a);

    public static nint Call(nint receiver, string selector, nint a, nint b) => Send(receiver, Selector(selector), a, b);

    /// <summary>A new NSString (autoreleased) holding <paramref name="text"/>.</summary>
    public static nint NSString(string text)
    {
        var utf8 = Marshal.StringToCoTaskMemUTF8(text);
        try
        {
            return Send(Class("NSString"), Selector("stringWithUTF8String:"), utf8);
        }
        finally
        {
            Marshal.FreeCoTaskMem(utf8);
        }
    }

    /// <summary>The text of an NSString (or a CFStringRef, which is the same object); null for nil.</summary>
    public static string? FromNSString(nint nsString)
    {
        if (nsString == 0)
        {
            return null;
        }

        var utf8 = Send(nsString, Selector("UTF8String"));
        return utf8 == 0 ? null : Marshal.PtrToStringUTF8(utf8);
    }

    /// <summary>The number of items of an NSArray.</summary>
    public static long Count(nint nsArray) => nsArray == 0 ? 0 : SendReturnLong(nsArray, Selector("count"));

    /// <summary>Item <paramref name="index"/> of an NSArray.</summary>
    public static nint At(nint nsArray, long index) => SendLongReturn(nsArray, Selector("objectAtIndex:"), index);

    [LibraryImport(Lib, EntryPoint = "objc_msgSend")]
    private static partial nint SendLongReturn(nint receiver, nint selector, long a);

    /// <summary>Runs <paramref name="body"/> inside an autorelease pool, so the objects it makes are freed.</summary>
    public static T InPool<T>(Func<T> body)
    {
        var pool = PoolPush();
        try
        {
            return body();
        }
        finally
        {
            PoolPop(pool);
        }
    }

    public static void InPool(Action body) => InPool(() =>
    {
        body();
        return 0;
    });
}

/// <summary>CoreGraphics' CGPoint, CGSize, CGRect: doubles on 64-bit macOS.</summary>
[StructLayout(LayoutKind.Sequential)]
internal struct CGPoint
{
    public double X;
    public double Y;

    public CGPoint(double x, double y)
    {
        X = x;
        Y = y;
    }
}

[StructLayout(LayoutKind.Sequential)]
internal struct CGSize
{
    public double Width;
    public double Height;
}

[StructLayout(LayoutKind.Sequential)]
internal struct CGRect
{
    public CGPoint Origin;
    public CGSize Size;

    public CGRect(double x, double y, double width, double height)
    {
        Origin = new CGPoint(x, y);
        Size = new CGSize { Width = width, Height = height };
    }

    public readonly Core.Platform.ScreenRect ToScreenRect() => new(
        (int)Math.Round(Origin.X), (int)Math.Round(Origin.Y), (int)Math.Round(Size.Width), (int)Math.Round(Size.Height));
}
