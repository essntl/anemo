namespace Anemo.Desktop.Core.Platform;

/// <summary>The size a screenshot is scaled to before it is sent.</summary>
public static class ScreenshotScaler
{
    /// <summary>At most this many pixels on the long side (device-contracts.md §3).</summary>
    public const int MaxSide = 1568;

    /// <summary>
    /// The target size for a capture of <paramref name="width"/> × <paramref name="height"/>
    /// screen pixels, and the scale (screen pixels per screenshot pixel, ≥ 1).
    /// </summary>
    public static (int Width, int Height, double Scale) Fit(int width, int height, int maxSide = MaxSide)
    {
        if (width <= 0 || height <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(width), "The capture has no size.");
        }

        var longSide = Math.Max(width, height);
        if (longSide <= maxSide)
        {
            return (width, height, 1.0);
        }

        var scale = (double)longSide / maxSide;
        var w = Math.Max(1, (int)Math.Round(width / scale));
        var h = Math.Max(1, (int)Math.Round(height / scale));
        return (Math.Min(w, maxSide), Math.Min(h, maxSide), scale);
    }

    /// <summary>A point in screenshot pixels back on the screen.</summary>
    public static ScreenPoint ToScreen(ScreenCapture capture, double x, double y) =>
        new(capture.OriginX + (int)Math.Round(x * capture.Scale),
            capture.OriginY + (int)Math.Round(y * capture.Scale));
}
