using System.Collections.Generic;
using System.IO;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace Anemo.Desktop.UI;

/// <summary>
/// Plain line icons (lucide shapes, as in the Figma design) on a 24x24 grid, drawn with round
/// caps and joins. WPF draws them directly; the WinForms tray menu and indicator get bitmaps.
/// </summary>
internal static class Icons
{
    public static readonly IReadOnlyDictionary<string, string> Paths = new Dictionary<string, string>
    {
        ["link"] = "M10,13 A5,5 0 0 0 17.5,13.5 L20.5,10.5 A5,5 0 0 0 13.5,3.5 L11.8,5.2 M14,11 A5,5 0 0 0 6.5,10.5 L3.5,13.5 A5,5 0 0 0 10.5,20.5 L12.2,18.8",
        ["monitor"] = "M4,3 H20 A2,2 0 0 1 22,5 V15 A2,2 0 0 1 20,17 H4 A2,2 0 0 1 2,15 V5 A2,2 0 0 1 4,3 Z M8,21 H16 M12,17 V21",
        ["code"] = "M16,18 L22,12 L16,6 M8,6 L2,12 L8,18",
        ["globe"] = "M3,12 A9,9 0 1 0 21,12 A9,9 0 1 0 3,12 Z M12,3 A14,14 0 0 0 12,21 A14,14 0 0 0 12,3 M3,12 H21",
        ["key"] = "M2.5,15.5 A5,5 0 1 0 12.5,15.5 A5,5 0 1 0 2.5,15.5 Z M21,2 L11.4,11.6 M15.5,7.5 L18.5,10.5 L22,7 L19,4",
        ["folder"] = "M20,20 A2,2 0 0 0 22,18 V8 A2,2 0 0 0 20,6 H12.1 A2,2 0 0 1 10.4,5.1 L9.6,3.9 A2,2 0 0 0 7.9,3 H4 A2,2 0 0 0 2,5 V18 A2,2 0 0 0 4,20 Z",
        ["branch"] = "M6,3 V15 M15,6 A3,3 0 1 0 21,6 A3,3 0 1 0 15,6 Z M3,18 A3,3 0 1 0 9,18 A3,3 0 1 0 3,18 Z M18,9 A9,9 0 0 1 9,18",
        ["terminal"] = "M4,17 L10,11 L4,5 M12,19 H20",
        ["pause"] = "M8,5 H9.5 A1,1 0 0 1 10.5,6 V18 A1,1 0 0 1 9.5,19 H8 A1,1 0 0 1 7,18 V6 A1,1 0 0 1 8,5 Z M14.5,5 H16 A1,1 0 0 1 17,6 V18 A1,1 0 0 1 16,19 H14.5 A1,1 0 0 1 13.5,18 V6 A1,1 0 0 1 14.5,5 Z",
        ["play"] = "M7,4.5 V19.5 L19,12 Z",
        ["share"] = "M13,3 H4 A2,2 0 0 0 2,5 V15 A2,2 0 0 0 4,17 H20 A2,2 0 0 0 22,15 V12 M8,21 H16 M12,17 V21 M17,8 L22,3 M17,3 H22 V8",
        ["power"] = "M12,2 V12 M18.4,6.6 A9,9 0 1 1 5.6,6.6",
        ["shield"] = "M20,13 C20,18 16.5,20.5 12.3,22 A1,1 0 0 1 11.7,22 C7.5,20.5 4,18 4,13 V6 A1,1 0 0 1 5,5 C7,5 9.5,3.8 11.2,2.3 A1.2,1.2 0 0 1 12.8,2.3 C14.5,3.8 17,5 19,5 A1,1 0 0 1 20,6 Z M12,8 V12 M12,16 H12.01",
        ["external"] = "M15,3 H21 V9 M10,14 L21,3 M18,13 V19 A2,2 0 0 1 16,21 H5 A2,2 0 0 1 3,19 V8 A2,2 0 0 1 5,6 H11",
        ["check"] = "M20,6 L9,17 L4,12",
        ["alert"] = "M3,12 A9,9 0 1 0 21,12 A9,9 0 1 0 3,12 Z M12,8 V12.5 M12,16 H12.01",
        ["minus"] = "M5,12 H19",
        ["close"] = "M18,6 L6,18 M6,6 L18,18",
        ["pointer"] = "M4,4 L11,21 L13.5,13.5 L21,11 Z",
        ["sliders"] = "M4,6 H14 M18,6 H20 M4,12 H8 M12,12 H20 M4,18 H16 M14,6 A2,2 0 1 0 18,6 A2,2 0 1 0 14,6 Z M8,12 A2,2 0 1 0 12,12 A2,2 0 1 0 8,12 Z M16,18 A2,2 0 1 0 20,18 A2,2 0 1 0 16,18 Z",
        ["list"] = "M8,6 H21 M8,12 H21 M8,18 H21 M3,6 H3.01 M3,12 H3.01 M3,18 H3.01",
        ["logout"] = "M9,21 H5 A2,2 0 0 1 3,19 V5 A2,2 0 0 1 5,3 H9 M16,17 L21,12 L16,7 M21,12 H9",
        ["stop"] = "M8,6 H16 A2,2 0 0 1 18,8 V16 A2,2 0 0 1 16,18 H8 A2,2 0 0 1 6,16 V8 A2,2 0 0 1 8,6 Z",
    };

    /// <summary>The Anemo mark's three strokes (frontend/src/components/ui/Logo.tsx), already moved by (0.75, 1.5).</summary>
    public const string Mark = "M5.75,9.5 H13.25 A2.5,2.5 0 1 0 10.75,7 M2.25,13.5 H18.25 A3,3 0 1 1 15.25,16.5 M4.75,17.5 H11.25";

    public static Geometry Geometry(string name) => System.Windows.Media.Geometry.Parse(Paths[name]);

    public static Pen Pen(Brush brush, double thickness) => new(brush, thickness)
    {
        StartLineCap = PenLineCap.Round,
        EndLineCap = PenLineCap.Round,
        LineJoin = PenLineJoin.Round,
    };

    /// <summary>An icon as a bitmap for WinForms, <paramref name="px"/> pixels square.</summary>
    public static System.Drawing.Bitmap Bitmap(string name, string hex, int px, double stroke = 1.9)
    {
        var visual = new DrawingVisual();
        using (var dc = visual.RenderOpen())
        {
            dc.PushTransform(new ScaleTransform(px / 24.0, px / 24.0));
            dc.DrawGeometry(null, Pen(new SolidColorBrush(Palette.Media(hex)), stroke), Geometry(name));
        }

        return ToBitmap(visual, px, px);
    }

    /// <summary>The Anemo mark on its dark tile, as a bitmap for WinForms.</summary>
    public static System.Drawing.Bitmap Logo(int px, bool edge = false)
    {
        var visual = new DrawingVisual();
        using (var dc = visual.RenderOpen())
        {
            dc.PushTransform(new ScaleTransform(px / 24.0, px / 24.0));
            var rim = edge ? new Pen(new SolidColorBrush(Color.FromArgb(40, 255, 255, 255)), 24.0 / px) : null;
            dc.DrawRoundedRectangle(new SolidColorBrush(Palette.Media(Palette.Tile)), rim, new Rect(0, 0, 24, 24), 5.5, 5.5);
            dc.PushTransform(new MatrixTransform(0.64, 0, 0, 0.64, 4.32, 4.32));
            dc.DrawGeometry(null, Pen(LogoTile.Fade(Colors.White), 1.7), System.Windows.Media.Geometry.Parse(Mark));
        }

        return ToBitmap(visual, px, px);
    }

    private static System.Drawing.Bitmap ToBitmap(Visual visual, int width, int height)
    {
        var target = new RenderTargetBitmap(width, height, 96, 96, PixelFormats.Pbgra32);
        target.Render(visual);
        var encoder = new PngBitmapEncoder();
        encoder.Frames.Add(BitmapFrame.Create(target));
        using var stream = new MemoryStream();
        encoder.Save(stream);
        stream.Position = 0;
        using var decoded = new System.Drawing.Bitmap(stream);
        return new System.Drawing.Bitmap(decoded); // a copy that doesn't need the stream
    }
}
