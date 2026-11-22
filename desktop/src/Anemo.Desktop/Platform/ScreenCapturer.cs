using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using Anemo.Desktop.Core.Platform;

namespace Anemo.Desktop.Platform;

/// <summary>
/// Screenshots with Windows.Graphics.Capture, falling back to GDI (BitBlt for the screen,
/// PrintWindow for a window behind others) on any failure or timeout; scaled to at most
/// 1568 px on the long side, as PNG. Anemo Desktop's own indicator is excluded from
/// captures by Windows (SetWindowDisplayAffinity) on both paths.
/// </summary>
internal static class ScreenCapturer
{
    public static ScreenRect VirtualScreen() => new(
        Win32.GetSystemMetrics(Win32.SmXVirtualScreen),
        Win32.GetSystemMetrics(Win32.SmYVirtualScreen),
        Win32.GetSystemMetrics(Win32.SmCxVirtualScreen),
        Win32.GetSystemMetrics(Win32.SmCyVirtualScreen));

    /// <summary>Set after a Windows.Graphics.Capture failure, so the next capture doesn't wait for it again.</summary>
    private static DateTime _graphicsCaptureFailedAt = DateTime.MinValue;

    public static ScreenCapture Screen()
    {
        var screen = VirtualScreen();
        return Try(() => GraphicsCapture.Region(screen), screen.X, screen.Y) ?? FromScreen(screen);
    }

    public static ScreenCapture Window(IntPtr hwnd)
    {
        var bounds = Windows.Bounds(hwnd);
        if (bounds.Width == 0 || bounds.Height == 0)
        {
            return Screen();
        }

        // In front: what the user sees there (menus and popups included). Behind others:
        // the window as it draws itself.
        var front = Win32.GetAncestor(Win32.GetForegroundWindow(), Win32.GaRoot) == hwnd;
        if (front)
        {
            var visible = Clip(bounds);
            return Try(() => GraphicsCapture.Region(visible), visible.X, visible.Y) ?? FromScreen(visible);
        }

        return Try(() => GraphicsCapture.Window(hwnd), bounds.X, bounds.Y)
            ?? FromPrintWindow(hwnd, bounds)
            ?? FromScreen(Clip(bounds));
    }

    /// <summary>The Windows.Graphics.Capture path, or null to fall back to GDI.</summary>
    private static ScreenCapture? Try(Func<Bitmap> capture, int originX, int originY)
    {
        if (DateTime.UtcNow - _graphicsCaptureFailedAt < TimeSpan.FromMinutes(5) || !GraphicsCapture.Available)
        {
            return null;
        }

        try
        {
            using var bitmap = capture();
            return Encode(bitmap, originX, originY);
        }
        catch (Exception e)
        {
            System.Diagnostics.Debug.WriteLine($"Windows.Graphics.Capture failed: {e.GetType().Name}");
            _graphicsCaptureFailedAt = DateTime.UtcNow;
            GraphicsCapture.Reset();
            return null;
        }
    }

    private static ScreenRect Clip(ScreenRect r)
    {
        var s = VirtualScreen();
        var left = Math.Max(r.X, s.X);
        var top = Math.Max(r.Y, s.Y);
        var right = Math.Min(r.X + r.Width, s.X + s.Width);
        var bottom = Math.Min(r.Y + r.Height, s.Y + s.Height);
        return right > left && bottom > top ? new ScreenRect(left, top, right - left, bottom - top) : s;
    }

    private static ScreenCapture FromScreen(ScreenRect r)
    {
        using var bitmap = new Bitmap(r.Width, r.Height, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bitmap))
        {
            g.CopyFromScreen(r.X, r.Y, 0, 0, new Size(r.Width, r.Height), CopyPixelOperation.SourceCopy);
        }

        return Encode(bitmap, r.X, r.Y);
    }

    private static ScreenCapture? FromPrintWindow(IntPtr hwnd, ScreenRect visible)
    {
        Win32.GetWindowRect(hwnd, out var outer);
        var width = outer.Right - outer.Left;
        var height = outer.Bottom - outer.Top;
        if (width <= 0 || height <= 0)
        {
            return null;
        }

        using var full = new Bitmap(width, height, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(full))
        {
            var hdc = g.GetHdc();
            try
            {
                if (!Win32.PrintWindow(hwnd, hdc, Win32.PwRenderFullContent))
                {
                    return null;
                }
            }
            finally
            {
                g.ReleaseHdc(hdc);
            }
        }

        // GetWindowRect includes the invisible resize border; keep the visible part.
        var crop = new Rectangle(visible.X - outer.Left, visible.Y - outer.Top, visible.Width, visible.Height);
        crop.Intersect(new Rectangle(0, 0, width, height));
        if (crop.Width <= 0 || crop.Height <= 0)
        {
            return null;
        }

        using var cropped = full.Clone(crop, PixelFormat.Format32bppArgb);
        return Encode(cropped, outer.Left + crop.X, outer.Top + crop.Y);
    }

    private static ScreenCapture Encode(Bitmap source, int originX, int originY)
    {
        var (width, height, scale) = ScreenshotScaler.Fit(source.Width, source.Height);
        using var stream = new MemoryStream();
        if (scale == 1.0)
        {
            source.Save(stream, ImageFormat.Png);
        }
        else
        {
            using var scaled = new Bitmap(width, height, PixelFormat.Format24bppRgb);
            using (var g = Graphics.FromImage(scaled))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.DrawImage(source, new Rectangle(0, 0, width, height));
            }

            scaled.Save(stream, ImageFormat.Png);
        }

        return new ScreenCapture(stream.ToArray(), width, height, scale, originX, originY);
    }
}
