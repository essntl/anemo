using System.Runtime.InteropServices;

namespace Anemo.Desktop.Mac.Native;

/// <summary>
/// CoreGraphics (Quartz): displays, the window list, input events, bitmaps; and ImageIO for PNG.
/// Quartz coordinates are points with the origin at the top-left of the main display, y down,
/// the same space Accessibility uses (docs/specs/09-desktop-macos.md D4).
/// </summary>
internal static partial class CG
{
    private const string Lib = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";
    private const string ImageIOLib = "/System/Library/Frameworks/ImageIO.framework/ImageIO";

    // -- displays -----------------------------------------------------------------------

    [LibraryImport(Lib, EntryPoint = "CGMainDisplayID")]
    public static partial uint MainDisplay();

    [LibraryImport(Lib, EntryPoint = "CGGetActiveDisplayList")]
    private static partial int CGGetActiveDisplayList(uint max, [Out] uint[] displays, out uint count);

    [LibraryImport(Lib, EntryPoint = "CGDisplayBounds")]
    public static partial CGRect DisplayBounds(uint display);

    [LibraryImport(Lib, EntryPoint = "CGDisplayCopyDisplayMode")]
    private static partial nint CGDisplayCopyDisplayMode(uint display);

    [LibraryImport(Lib, EntryPoint = "CGDisplayModeGetPixelWidth")]
    private static partial nuint CGDisplayModeGetPixelWidth(nint mode);

    [LibraryImport(Lib, EntryPoint = "CGDisplayModeRelease")]
    private static partial void CGDisplayModeRelease(nint mode);

    public static uint[] ActiveDisplays()
    {
        var ids = new uint[16];
        return CGGetActiveDisplayList((uint)ids.Length, ids, out var count) == 0 ? ids[..(int)count] : [MainDisplay()];
    }

    /// <summary>Pixels per point of a display: 2 on Retina, 1 otherwise.</summary>
    public static double PixelsPerPoint(uint display)
    {
        var points = DisplayBounds(display).Size.Width;
        var mode = CGDisplayCopyDisplayMode(display);
        if (mode == 0 || points <= 0)
        {
            return 1;
        }

        try
        {
            return Math.Max(1, CGDisplayModeGetPixelWidth(mode) / points);
        }
        finally
        {
            CGDisplayModeRelease(mode);
        }
    }

    // -- permission (Screen Recording) --------------------------------------------------

    /// <summary>Screen Recording is allowed for this app; never asks.</summary>
    [LibraryImport(Lib, EntryPoint = "CGPreflightScreenCaptureAccess")]
    [return: MarshalAs(UnmanagedType.U1)]
    public static partial bool PreflightScreenCapture();

    /// <summary>Asks macOS for Screen Recording (its own prompt, once); true when allowed already.</summary>
    [LibraryImport(Lib, EntryPoint = "CGRequestScreenCaptureAccess")]
    [return: MarshalAs(UnmanagedType.U1)]
    public static partial bool RequestScreenCapture();

    // -- windows ------------------------------------------------------------------------

    public const uint OnScreenOnly = 1 << 0; // kCGWindowListOptionOnScreenOnly
    public const uint ExcludeDesktopElements = 1 << 4; // kCGWindowListExcludeDesktopElements
    public const uint OptionAll = 0;

    /// <summary>An array of window dictionaries (kCGWindowNumber, kCGWindowOwnerPID, …), front first. Release it.</summary>
    [LibraryImport(Lib, EntryPoint = "CGWindowListCopyWindowInfo")]
    public static partial nint WindowList(uint option, uint relativeToWindow);

    [LibraryImport(Lib, EntryPoint = "CGRectMakeWithDictionaryRepresentation")]
    [return: MarshalAs(UnmanagedType.U1)]
    public static partial bool RectFromDictionary(nint dict, out CGRect rect);

    [LibraryImport(Lib, EntryPoint = "CGSessionCopyCurrentDictionary")]
    public static partial nint SessionDictionary();

    // -- input events -------------------------------------------------------------------

    public const int HidEventTap = 0; // kCGHIDEventTap

    public const int LeftMouseDown = 1;
    public const int LeftMouseUp = 2;
    public const int RightMouseDown = 3;
    public const int RightMouseUp = 4;
    public const int MouseMoved = 5;

    public const int MouseEventClickState = 1; // kCGMouseEventClickState
    public const int ScrollUnitLine = 1; // kCGScrollEventUnitLine

    [LibraryImport(Lib, EntryPoint = "CGEventCreateMouseEvent")]
    public static partial nint MouseEvent(nint source, int type, CGPoint at, int button);

    [LibraryImport(Lib, EntryPoint = "CGEventCreateKeyboardEvent")]
    public static partial nint KeyEvent(nint source, ushort keyCode, [MarshalAs(UnmanagedType.U1)] bool down);

    [LibraryImport(Lib, EntryPoint = "CGEventKeyboardSetUnicodeString", StringMarshalling = StringMarshalling.Utf16)]
    public static partial void SetUnicode(nint evt, nuint length, string text);

    /// <summary>The non-variadic scroll event (macOS 10.13+): P/Invoke can't call the variadic one on arm64.</summary>
    [LibraryImport(Lib, EntryPoint = "CGEventCreateScrollWheelEvent2")]
    public static partial nint ScrollEvent(nint source, int units, uint wheelCount, int wheel1, int wheel2, int wheel3);

    [LibraryImport(Lib, EntryPoint = "CGEventSetLocation")]
    public static partial void SetLocation(nint evt, CGPoint at);

    [LibraryImport(Lib, EntryPoint = "CGEventSetFlags")]
    public static partial void SetFlags(nint evt, ulong flags);

    [LibraryImport(Lib, EntryPoint = "CGEventSetIntegerValueField")]
    public static partial void SetField(nint evt, int field, long value);

    [LibraryImport(Lib, EntryPoint = "CGEventPost")]
    public static partial void Post(int tap, nint evt);

    // -- bitmaps and PNG ----------------------------------------------------------------

    public const uint PremultipliedFirstLittle = 2 | (2 << 12); // kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little

    [LibraryImport(Lib, EntryPoint = "CGColorSpaceCreateDeviceRGB")]
    public static partial nint DeviceRgb();

    [LibraryImport(Lib, EntryPoint = "CGColorSpaceRelease")]
    public static partial void ReleaseColorSpace(nint space);

    [LibraryImport(Lib, EntryPoint = "CGBitmapContextCreate")]
    public static partial nint BitmapContext(nint data, nuint width, nuint height, nuint bitsPerComponent, nuint bytesPerRow, nint space, uint info);

    [LibraryImport(Lib, EntryPoint = "CGContextDrawImage")]
    public static partial void DrawImage(nint context, CGRect rect, nint image);

    [LibraryImport(Lib, EntryPoint = "CGContextSetRGBFillColor")]
    public static partial void SetFill(nint context, double r, double g, double b, double a);

    [LibraryImport(Lib, EntryPoint = "CGContextFillRect")]
    public static partial void FillRect(nint context, CGRect rect);

    [LibraryImport(Lib, EntryPoint = "CGBitmapContextCreateImage")]
    public static partial nint ImageOf(nint context);

    [LibraryImport(Lib, EntryPoint = "CGContextRelease")]
    public static partial void ReleaseContext(nint context);

    [LibraryImport(Lib, EntryPoint = "CGImageGetWidth")]
    public static partial nuint ImageWidth(nint image);

    [LibraryImport(Lib, EntryPoint = "CGImageGetHeight")]
    public static partial nuint ImageHeight(nint image);

    [LibraryImport(Lib, EntryPoint = "CGImageRelease")]
    public static partial void ReleaseImage(nint image);

    [LibraryImport(ImageIOLib, EntryPoint = "CGImageDestinationCreateWithData")]
    private static partial nint CGImageDestinationCreateWithData(nint data, nint type, nuint count, nint options);

    [LibraryImport(ImageIOLib, EntryPoint = "CGImageDestinationAddImage")]
    private static partial void CGImageDestinationAddImage(nint destination, nint image, nint properties);

    [LibraryImport(ImageIOLib, EntryPoint = "CGImageDestinationFinalize")]
    [return: MarshalAs(UnmanagedType.U1)]
    private static partial bool CGImageDestinationFinalize(nint destination);

    /// <summary>The image as PNG bytes (ImageIO).</summary>
    public static byte[] Png(nint image)
    {
        var data = CF.DataCreateMutable(0, 0);
        var type = CF.String("public.png");
        var destination = CGImageDestinationCreateWithData(data, type, 1, 0);
        try
        {
            if (destination == 0)
            {
                throw new InvalidOperationException("ImageIO can't write PNG.");
            }

            CGImageDestinationAddImage(destination, image, 0);
            return CGImageDestinationFinalize(destination) ? CF.Bytes(data) : throw new InvalidOperationException("The PNG couldn't be written.");
        }
        finally
        {
            CF.Release(destination);
            CF.Release(type);
            CF.Release(data);
        }
    }
}
