using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using Anemo.Desktop.Core;

namespace Anemo.Desktop.UI;

/// <summary>The three tray icons (grey, normal, red), drawn at start so no image files are needed.</summary>
internal sealed class TrayIcons : IDisposable
{
    private readonly Icon _grey = Draw(Color.FromArgb(140, 140, 140));
    private readonly Icon _normal = Draw(Color.FromArgb(13, 148, 136));
    private readonly Icon _red = Draw(Color.FromArgb(220, 38, 38));

    public Icon For(TrayIcon icon) => icon switch
    {
        TrayIcon.Red => _red,
        TrayIcon.Normal => _normal,
        _ => _grey,
    };

    public void Dispose()
    {
        _grey.Dispose();
        _normal.Dispose();
        _red.Dispose();
    }

    private static Icon Draw(Color color)
    {
        using var bitmap = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(bitmap))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);
            using var fill = new SolidBrush(color);
            g.FillEllipse(fill, 2, 2, 28, 28);
            using var font = new Font("Segoe UI", 15, FontStyle.Bold, GraphicsUnit.Pixel);
            using var white = new SolidBrush(Color.White);
            var format = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
            g.DrawString("A", font, white, new RectangleF(0, 1, 32, 32), format);
        }

        var handle = bitmap.GetHicon();
        try
        {
            return (Icon)Icon.FromHandle(handle).Clone();
        }
        finally
        {
            DestroyIcon(handle);
        }
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyIcon(IntPtr handle);
}
