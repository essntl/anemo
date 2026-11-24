using System.Runtime.InteropServices;
using System.Text;

namespace Anemo.Desktop.Mac.Native;

/// <summary>
/// CoreFoundation: the C types the other frameworks hand out (CFString, CFNumber, CFArray,
/// CFDictionary, CFData). Whatever a "Create" or "Copy" function returns is ours to
/// <see cref="Release"/>; what a "Get" function returns is not.
/// </summary>
internal static partial class CF
{
    public const string Lib = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";

    private const uint Utf8 = 0x08000100; // kCFStringEncodingUTF8
    private const int NumberDouble = 13; // kCFNumberDoubleType
    private const int NumberLong = 10; // kCFNumberLongType (64-bit)

    [LibraryImport(Lib, EntryPoint = "CFRelease")]
    private static partial void CFRelease(nint obj);

    [LibraryImport(Lib, EntryPoint = "CFRetain")]
    public static partial nint Retain(nint obj);

    [LibraryImport(Lib, EntryPoint = "CFGetTypeID")]
    public static partial nuint TypeOf(nint obj);

    [LibraryImport(Lib, EntryPoint = "CFStringGetTypeID")]
    public static partial nuint StringType();

    [LibraryImport(Lib, EntryPoint = "CFBooleanGetTypeID")]
    public static partial nuint BooleanType();

    [LibraryImport(Lib, EntryPoint = "CFNumberGetTypeID")]
    public static partial nuint NumberType();

    [LibraryImport(Lib, EntryPoint = "CFArrayGetTypeID")]
    public static partial nuint ArrayType();

    [LibraryImport(Lib, EntryPoint = "CFStringCreateWithBytes")]
    private static partial nint CFStringCreateWithBytes(nint alloc, byte[] bytes, nint length, uint encoding, [MarshalAs(UnmanagedType.U1)] bool external);

    [LibraryImport(Lib, EntryPoint = "CFStringGetLength")]
    private static partial nint CFStringGetLength(nint str);

    [LibraryImport(Lib, EntryPoint = "CFStringGetMaximumSizeForEncoding")]
    private static partial nint CFStringGetMaximumSizeForEncoding(nint length, uint encoding);

    [LibraryImport(Lib, EntryPoint = "CFStringGetCString")]
    [return: MarshalAs(UnmanagedType.U1)]
    private static partial bool CFStringGetCString(nint str, byte[] buffer, nint size, uint encoding);

    [LibraryImport(Lib, EntryPoint = "CFNumberCreate")]
    private static partial nint CFNumberCreate(nint alloc, int type, ref double value);

    [LibraryImport(Lib, EntryPoint = "CFNumberGetValue")]
    [return: MarshalAs(UnmanagedType.U1)]
    private static partial bool CFNumberGetValue(nint number, int type, out double value);

    [LibraryImport(Lib, EntryPoint = "CFNumberGetValue")]
    [return: MarshalAs(UnmanagedType.U1)]
    private static partial bool CFNumberGetValueLong(nint number, int type, out long value);

    [LibraryImport(Lib, EntryPoint = "CFBooleanGetValue")]
    [return: MarshalAs(UnmanagedType.U1)]
    private static partial bool CFBooleanGetValue(nint boolean);

    [LibraryImport(Lib, EntryPoint = "CFArrayGetCount")]
    public static partial nint ArrayCount(nint array);

    [LibraryImport(Lib, EntryPoint = "CFArrayGetValueAtIndex")]
    public static partial nint ArrayAt(nint array, nint index);

    [LibraryImport(Lib, EntryPoint = "CFDictionaryGetValue")]
    public static partial nint DictionaryGet(nint dict, nint key);

    [LibraryImport(Lib, EntryPoint = "CFDictionaryCreate")]
    private static partial nint CFDictionaryCreate(nint alloc, nint[] keys, nint[] values, nint count, nint keyCallbacks, nint valueCallbacks);

    [LibraryImport(Lib, EntryPoint = "CFDataCreateMutable")]
    public static partial nint DataCreateMutable(nint alloc, nint capacity);

    [LibraryImport(Lib, EntryPoint = "CFDataCreate")]
    private static partial nint CFDataCreate(nint alloc, byte[] bytes, nint length);

    [LibraryImport(Lib, EntryPoint = "CFDataGetLength")]
    private static partial nint CFDataGetLength(nint data);

    [LibraryImport(Lib, EntryPoint = "CFDataGetBytePtr")]
    private static partial nint CFDataGetBytePtr(nint data);

    private static readonly nint Handle = NativeLibrary.Load(Lib);

    /// <summary>The address a CoreFoundation global constant (kCFBooleanTrue, …) holds.</summary>
    public static nint Constant(nint library, string name) => Marshal.ReadIntPtr(NativeLibrary.GetExport(library, name));

    public static nint True => Constant(Handle, "kCFBooleanTrue");

    public static nint False => Constant(Handle, "kCFBooleanFalse");

    private static nint KeyCallbacks => NativeLibrary.GetExport(Handle, "kCFTypeDictionaryKeyCallBacks");

    private static nint ValueCallbacks => NativeLibrary.GetExport(Handle, "kCFTypeDictionaryValueCallBacks");

    public static void Release(nint obj)
    {
        if (obj != 0)
        {
            CFRelease(obj);
        }
    }

    /// <summary>A new CFString (release it).</summary>
    public static nint String(string text)
    {
        var bytes = Encoding.UTF8.GetBytes(text);
        return CFStringCreateWithBytes(0, bytes, bytes.Length, Utf8, false);
    }

    /// <summary>The text of a CFString; null when it isn't one.</summary>
    public static string? ToText(nint str)
    {
        if (str == 0 || TypeOf(str) != StringType())
        {
            return null;
        }

        var size = CFStringGetMaximumSizeForEncoding(CFStringGetLength(str), Utf8) + 1;
        var buffer = new byte[size];
        return CFStringGetCString(str, buffer, size, Utf8) ? Encoding.UTF8.GetString(buffer, 0, Array.IndexOf(buffer, (byte)0)) : null;
    }

    public static nint Number(double value) => CFNumberCreate(0, NumberDouble, ref value);

    public static double? ToDouble(nint number) =>
        number != 0 && TypeOf(number) == NumberType() && CFNumberGetValue(number, NumberDouble, out var v) ? v : null;

    public static long? ToLong(nint number) =>
        number != 0 && TypeOf(number) == NumberType() && CFNumberGetValueLong(number, NumberLong, out var v) ? v : null;

    public static int? ToInt(nint number) => ToLong(number) is { } v ? (int)v : null;

    public static bool? ToBool(nint value)
    {
        if (value == 0)
        {
            return null;
        }

        if (TypeOf(value) == BooleanType())
        {
            return CFBooleanGetValue(value);
        }

        return ToLong(value) is { } n ? n != 0 : null;
    }

    /// <summary>A new CFDictionary of CF objects (release it; the keys and values are retained by it).</summary>
    public static nint Dictionary(params (nint Key, nint Value)[] pairs) =>
        CFDictionaryCreate(0, pairs.Select(p => p.Key).ToArray(), pairs.Select(p => p.Value).ToArray(), pairs.Length, KeyCallbacks, ValueCallbacks);

    /// <summary>A value of a dictionary by a string key.</summary>
    public static nint Get(nint dict, string key)
    {
        var cfKey = String(key);
        try
        {
            return DictionaryGet(dict, cfKey);
        }
        finally
        {
            Release(cfKey);
        }
    }

    public static nint Data(byte[] bytes) => CFDataCreate(0, bytes, bytes.Length);

    public static byte[] Bytes(nint data)
    {
        var length = (int)CFDataGetLength(data);
        var bytes = new byte[length];
        Marshal.Copy(CFDataGetBytePtr(data), bytes, 0, length);
        return bytes;
    }
}
