using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Threading.Tasks;
using Anemo.Desktop.Core.Platform;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;
using WinRT;

namespace Anemo.Desktop.Platform;

/// <summary>
/// Screenshots with Windows.Graphics.Capture (Windows 10 1903 and later): one frame of a
/// monitor or a window, copied to the CPU with SoftwareBitmap. Every failure or a frame
/// that doesn't come within <see cref="FrameWait"/> throws, and
/// <see cref="ScreenCapturer"/> falls back to GDI.
/// </summary>
internal static class GraphicsCapture
{
    private static readonly TimeSpan FrameWait = TimeSpan.FromSeconds(1.5);
    private static readonly Guid GraphicsCaptureItemIid = new("79C3F95B-31F7-4EC2-A464-632EF5D30760");
    private static readonly Guid InteropIid = new("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356");
    private static readonly Guid DxgiDeviceIid = new("54ec77fa-1377-44e6-8c32-88fd5f44c84c");
    private static readonly object DeviceLock = new();
    private static IDirect3DDevice? _device;

    /// <summary>True on Windows versions where the API works at all.</summary>
    public static bool Available =>
        OperatingSystem.IsWindowsVersionAtLeast(10, 0, 18362) && GraphicsCaptureSession.IsSupported();

    /// <summary>
    /// What is on the screen in <paramref name="region"/> (physical pixels), assembled from
    /// the monitors it touches: like a screen copy, so menus and popups over a window show.
    /// </summary>
    public static Bitmap Region(ScreenRect region)
    {
        var result = new Bitmap(region.Width, region.Height, PixelFormat.Format32bppArgb);
        try
        {
            using var g = Graphics.FromImage(result);
            g.Clear(Color.Black);
            var touched = 0;
            foreach (var (monitor, bounds) in Monitors())
            {
                var overlap = Rectangle.Intersect(bounds, new Rectangle(region.X, region.Y, region.Width, region.Height));
                if (overlap.IsEmpty)
                {
                    continue;
                }

                using var frame = Capture(CreateForMonitor(monitor));
                g.DrawImage(
                    frame,
                    new Rectangle(overlap.X - region.X, overlap.Y - region.Y, overlap.Width, overlap.Height),
                    new Rectangle(overlap.X - bounds.X, overlap.Y - bounds.Y, overlap.Width, overlap.Height),
                    GraphicsUnit.Pixel);
                touched++;
            }

            return touched > 0 ? result : throw new InvalidOperationException("No monitor in the region.");
        }
        catch
        {
            result.Dispose();
            throw;
        }
    }

    /// <summary>One window as it draws itself, even behind others.</summary>
    public static Bitmap Window(IntPtr hwnd) => Capture(CreateForWindow(hwnd));

    private static Bitmap Capture(GraphicsCaptureItem item)
    {
        var size = item.Size;
        if (size.Width <= 0 || size.Height <= 0)
        {
            throw new InvalidOperationException("Nothing to capture.");
        }

        using var pool = Direct3D11CaptureFramePool.CreateFreeThreaded(Device(), DirectXPixelFormat.B8G8R8A8UIntNormalized, 1, size);
        using var session = pool.CreateCaptureSession(item);
        if (OperatingSystem.IsWindowsVersionAtLeast(10, 0, 19041))
        {
            session.IsCursorCaptureEnabled = false; // like the GDI path: no pointer in the picture
        }

        TryHideBorder(session);
        var arrived = new TaskCompletionSource<Direct3D11CaptureFrame>(TaskCreationOptions.RunContinuationsAsynchronously);
        pool.FrameArrived += (p, _) =>
        {
            var next = p.TryGetNextFrame();
            if (next is not null && !arrived.TrySetResult(next))
            {
                next.Dispose();
            }
        };
        session.StartCapture();
        if (!arrived.Task.Wait(FrameWait))
        {
            throw new TimeoutException("No frame from Windows.Graphics.Capture.");
        }

        using var frame = arrived.Task.Result;
        using var software = SoftwareBitmap.CreateCopyFromSurfaceAsync(frame.Surface, BitmapAlphaMode.Ignore)
            .AsTask().GetAwaiter().GetResult();
        return ToBitmap(software, frame.ContentSize.Width, frame.ContentSize.Height);
    }

    /// <summary>The yellow capture border can be switched off on Windows 11; on Windows 10 it flashes briefly.</summary>
    private static void TryHideBorder(GraphicsCaptureSession session)
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(10, 0, 20348))
        {
            return;
        }

        try
        {
            session.IsBorderRequired = false;
        }
        catch (Exception e) when (e is UnauthorizedAccessException or COMException or InvalidOperationException)
        {
            // Not allowed for this app: the border shows; the capture still works.
        }
    }

    private static Bitmap ToBitmap(SoftwareBitmap software, int contentWidth, int contentHeight)
    {
        using var bgra = software.BitmapPixelFormat == BitmapPixelFormat.Bgra8
            ? SoftwareBitmap.Copy(software)
            : SoftwareBitmap.Convert(software, BitmapPixelFormat.Bgra8);
        var width = bgra.PixelWidth;
        var height = bgra.PixelHeight;
        var buffer = new global::Windows.Storage.Streams.Buffer((uint)(width * height * 4));
        bgra.CopyToBuffer(buffer);
        var bytes = buffer.ToArray();

        var w = Math.Clamp(contentWidth, 1, width);
        var h = Math.Clamp(contentHeight, 1, height);
        var bitmap = new Bitmap(w, h, PixelFormat.Format32bppRgb);
        var data = bitmap.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppRgb);
        try
        {
            var stride = bytes.Length / height;
            for (var y = 0; y < h; y++)
            {
                Marshal.Copy(bytes, y * stride, data.Scan0 + (y * data.Stride), w * 4);
            }
        }
        finally
        {
            bitmap.UnlockBits(data);
        }

        return bitmap;
    }

    /// <summary>Forgets the Direct3D device (after a failure, e.g. a GPU reset).</summary>
    public static void Reset()
    {
        lock (DeviceLock)
        {
            _device = null;
        }
    }

    private static IDirect3DDevice Device()
    {
        lock (DeviceLock)
        {
            return _device ??= CreateDevice();
        }
    }

    private static IDirect3DDevice CreateDevice()
    {
        const uint bgraSupport = 0x20;
        const uint sdkVersion = 7;
        IntPtr d3d = IntPtr.Zero;
        var hr = -1;
        foreach (var driver in new[] { 1 /* hardware */, 5 /* WARP */ })
        {
            hr = D3D11CreateDevice(IntPtr.Zero, driver, IntPtr.Zero, bgraSupport, IntPtr.Zero, 0, sdkVersion, out d3d, out _, out var context);
            if (context != IntPtr.Zero)
            {
                Marshal.Release(context);
            }

            if (hr >= 0)
            {
                break;
            }
        }

        Marshal.ThrowExceptionForHR(hr);
        try
        {
            var iid = DxgiDeviceIid;
            Marshal.ThrowExceptionForHR(Marshal.QueryInterface(d3d, ref iid, out var dxgi));
            try
            {
                Marshal.ThrowExceptionForHR(CreateDirect3D11DeviceFromDXGIDevice(dxgi, out var inspectable));
                try
                {
                    return MarshalInterface<IDirect3DDevice>.FromAbi(inspectable);
                }
                finally
                {
                    Marshal.Release(inspectable);
                }
            }
            finally
            {
                Marshal.Release(dxgi);
            }
        }
        finally
        {
            Marshal.Release(d3d);
        }
    }

    private static GraphicsCaptureItem CreateForWindow(IntPtr hwnd) =>
        WithInterop(interop => interop.CreateForWindow(hwnd, GraphicsCaptureItemIid));

    private static GraphicsCaptureItem CreateForMonitor(IntPtr monitor) =>
        WithInterop(interop => interop.CreateForMonitor(monitor, GraphicsCaptureItemIid));

    private static GraphicsCaptureItem WithInterop(Func<IGraphicsCaptureItemInterop, IntPtr> create)
    {
        const string className = "Windows.Graphics.Capture.GraphicsCaptureItem";
        Marshal.ThrowExceptionForHR(WindowsCreateString(className, className.Length, out var hstring));
        try
        {
            var iid = InteropIid;
            Marshal.ThrowExceptionForHR(RoGetActivationFactory(hstring, ref iid, out var factory));
            try
            {
                var interop = (IGraphicsCaptureItemInterop)Marshal.GetObjectForIUnknown(factory);
                var item = create(interop);
                try
                {
                    return GraphicsCaptureItem.FromAbi(item);
                }
                finally
                {
                    Marshal.Release(item);
                }
            }
            finally
            {
                Marshal.Release(factory);
            }
        }
        finally
        {
            WindowsDeleteString(hstring);
        }
    }

    private static List<(IntPtr Monitor, Rectangle Bounds)> Monitors()
    {
        var monitors = new List<(IntPtr, Rectangle)>();
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (monitor, _, rect, _) =>
        {
            var r = Marshal.PtrToStructure<Win32.Rect>(rect);
            monitors.Add((monitor, Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom)));
            return true;
        }, IntPtr.Zero);
        return monitors;
    }

    [ComImport]
    [Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IGraphicsCaptureItemInterop
    {
        IntPtr CreateForWindow([In] IntPtr window, [In] in Guid iid);

        IntPtr CreateForMonitor([In] IntPtr monitor, [In] in Guid iid);
    }

    private delegate bool MonitorEnumProc(IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data);

    [DllImport("d3d11.dll")]
    private static extern int D3D11CreateDevice(
        IntPtr adapter, int driverType, IntPtr software, uint flags, IntPtr featureLevels, uint featureLevelCount,
        uint sdkVersion, out IntPtr device, out int featureLevel, out IntPtr immediateContext);

    [DllImport("d3d11.dll")]
    private static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgiDevice, out IntPtr graphicsDevice);

    [DllImport("combase.dll", CharSet = CharSet.Unicode)]
    private static extern int WindowsCreateString(string source, int length, out IntPtr hstring);

    [DllImport("combase.dll")]
    private static extern int WindowsDeleteString(IntPtr hstring);

    [DllImport("combase.dll")]
    private static extern int RoGetActivationFactory(IntPtr activatableClassId, ref Guid iid, out IntPtr factory);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc callback, IntPtr data);
}
