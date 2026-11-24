using System.Collections.Concurrent;
using System.Runtime.InteropServices;

namespace Anemo.Desktop.Mac.Native;

/// <summary>
/// Objective-C blocks for completion handlers (ScreenCaptureKit answers through them). A block
/// is a small struct: a class pointer, flags, the function to call and a descriptor
/// (clang's "Block Implementation Specification"). These are "global" blocks: they capture
/// nothing, so macOS never copies them; which C# callback a call belongs to is looked up by the
/// block's own address, which the function gets as its first argument.
/// </summary>
internal static unsafe class Blocks
{
    private const int IsGlobal = 1 << 28; // BLOCK_IS_GLOBAL

    [StructLayout(LayoutKind.Sequential)]
    private struct Descriptor
    {
        public nuint Reserved;
        public nuint Size;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Literal
    {
        public nint Isa;
        public int Flags;
        public int Reserved;
        public nint Invoke;
        public Descriptor* Descriptor;
    }

    private static readonly nint GlobalBlockClass =
        NativeLibrary.GetExport(NativeLibrary.Load("/usr/lib/libSystem.B.dylib"), "_NSConcreteGlobalBlock");

    private static readonly ConcurrentDictionary<nint, Action<nint, nint>> Pending = new();

    /// <summary>
    /// A block <c>^(id first, NSError *error)</c> that runs <paramref name="callback"/> once and
    /// is freed then. Pass it where a completion handler of that shape is wanted. If the
    /// handler is never called, the block's 48 bytes stay allocated (no harm).
    /// </summary>
    public static nint TwoArgs(Action<nint, nint> callback)
    {
        var block = (Literal*)NativeMemory.AllocZeroed((nuint)(sizeof(Literal) + sizeof(Descriptor)));
        var descriptor = (Descriptor*)(block + 1);
        descriptor->Size = (nuint)sizeof(Literal);
        block->Isa = GlobalBlockClass;
        block->Flags = IsGlobal;
        block->Invoke = (nint)(delegate* unmanaged<nint, nint, nint, void>)&Invoke;
        block->Descriptor = descriptor;
        Pending[(nint)block] = callback;
        return (nint)block;
    }

    [UnmanagedCallersOnly]
    private static void Invoke(nint block, nint first, nint error)
    {
        if (!Pending.TryRemove(block, out var callback))
        {
            return;
        }

        try
        {
            callback(first, error);
        }
        catch (Exception)
        {
            // Never let an exception cross into Objective-C; the waiting side times out.
        }
        finally
        {
            NativeMemory.Free((void*)block);
        }
    }
}
