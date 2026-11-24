namespace Anemo.Desktop.Core.Platform;

/// <summary>
/// One display, in the host's screen units: physical pixels on Windows, points on macOS
/// (the global display space, top-left of the main display at 0,0, y downwards; a display left
/// of or above it has negative coordinates). <see cref="PixelsPerUnit"/> is 2 on a Retina display.
/// </summary>
public sealed record DisplayInfo(uint Id, ScreenRect Bounds, double PixelsPerUnit);

/// <summary>
/// How a screenshot of an area of the screen is made and read back (docs/specs/09-desktop-macos.md
/// D4). The screenshot is fitted from the area's size in screen units, so its <c>scale</c> is
/// units per screenshot pixel and a click at screenshot (x, y) is at
/// origin + (x, y) × scale, as <see cref="ScreenshotScaler.ToScreen"/> computes. On a Mac the
/// system renders each display's part at its size in the screenshot from its full-resolution
/// (Retina) image, so nothing is lost by fitting in points.
/// </summary>
public static class DisplayLayout
{
    /// <summary>The rectangle around every display (the "virtual screen").</summary>
    public static ScreenRect Union(IReadOnlyList<DisplayInfo> displays)
    {
        if (displays.Count == 0)
        {
            throw new ArgumentException("There is no display.", nameof(displays));
        }

        var left = displays.Min(d => d.Bounds.X);
        var top = displays.Min(d => d.Bounds.Y);
        var right = displays.Max(d => d.Bounds.X + d.Bounds.Width);
        var bottom = displays.Max(d => d.Bounds.Y + d.Bounds.Height);
        return new ScreenRect(left, top, right - left, bottom - top);
    }

    /// <summary>The screenshot of <paramref name="area"/>: its size in pixels and how it maps back.</summary>
    public static CapturePlan Plan(ScreenRect area, int maxSide = ScreenshotScaler.MaxSide)
    {
        var (width, height, scale) = ScreenshotScaler.Fit(area.Width, area.Height, maxSide);
        return new CapturePlan(width, height, scale, area.X, area.Y);
    }

    /// <summary>
    /// Where <paramref name="display"/> goes in the screenshot of <paramref name="plan"/>, in
    /// screenshot pixels from its top-left corner (clipped to the screenshot); null when the
    /// display is outside the planned area.
    /// </summary>
    public static PixelRect? Place(CapturePlan plan, ScreenRect display)
    {
        var left = (int)Math.Floor((display.X - plan.OriginX) / plan.Scale);
        var top = (int)Math.Floor((display.Y - plan.OriginY) / plan.Scale);
        var right = (int)Math.Ceiling((display.X + display.Width - plan.OriginX) / plan.Scale);
        var bottom = (int)Math.Ceiling((display.Y + display.Height - plan.OriginY) / plan.Scale);
        left = Math.Max(left, 0);
        top = Math.Max(top, 0);
        right = Math.Min(right, plan.Width);
        bottom = Math.Min(bottom, plan.Height);
        return right > left && bottom > top ? new PixelRect(left, top, right - left, bottom - top) : null;
    }

    /// <summary>
    /// The same rectangle measured from the bottom of the screenshot, as CoreGraphics bitmap
    /// contexts count y (their origin is the bottom-left corner).
    /// </summary>
    public static PixelRect FlipY(CapturePlan plan, PixelRect rect) =>
        rect with { Y = plan.Height - rect.Y - rect.Height };

    /// <summary>The display a point is on, or null (between displays, off every screen).</summary>
    public static DisplayInfo? DisplayAt(IReadOnlyList<DisplayInfo> displays, ScreenPoint point) =>
        displays.FirstOrDefault(d =>
            point.X >= d.Bounds.X && point.X < d.Bounds.X + d.Bounds.Width
            && point.Y >= d.Bounds.Y && point.Y < d.Bounds.Y + d.Bounds.Height);
}

/// <summary>A screenshot to make: <see cref="Width"/> × <see cref="Height"/> pixels of the area at the origin, <see cref="Scale"/> units per pixel.</summary>
public sealed record CapturePlan(int Width, int Height, double Scale, int OriginX, int OriginY);

/// <summary>A rectangle in screenshot pixels.</summary>
public readonly record struct PixelRect(int X, int Y, int Width, int Height);
