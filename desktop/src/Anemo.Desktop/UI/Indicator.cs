using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;
using Anemo.Desktop.Platform;

namespace Anemo.Desktop.UI;

/// <summary>
/// "Anemo is using this computer" with a Stop button, always on top in the corner of the
/// screen while a command runs. It never takes the focus (the agent may be typing) and is
/// left out of screenshots. A card with a red edge, in the light or dark of Windows' apps.
/// </summary>
internal sealed class Indicator : Form
{
    private const string Title = "Anemo is using this computer";

    private readonly Action _stop;
    private readonly Func<string> _stopKey;
    private Palette _palette = Palette.Light;
    private Rectangle _button;
    private bool _hover;
    private Bitmap? _pointer;
    private Bitmap? _square;

    /// <param name="stop">Stops control (the Stop button).</param>
    /// <param name="stopKey">The stop hotkey, shown under the title.</param>
    public Indicator(Action stop, Func<string> stopKey)
    {
        _stop = stop;
        _stopKey = stopKey;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        AutoScaleMode = AutoScaleMode.None;
        DoubleBuffered = true;
        Text = Title;
    }

    protected override bool ShowWithoutActivation => true;

    protected override CreateParams CreateParams
    {
        get
        {
            var p = base.CreateParams;
            p.ExStyle |= Win32.WsExNoActivate | Win32.WsExToolWindow | Win32.WsExTopmost;
            return p;
        }
    }

    private float Dpi => DeviceDpi / 96f;

    public void ShowInCorner()
    {
        Prepare();
        var area = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1024, 768);
        Location = new Point(area.Right - Width - 12, area.Bottom - Height - 12);
        StyleFrame();
        Invalidate();
        if (!Visible)
        {
            Show();
        }
    }

    /// <summary>Colours, icons and size for the current theme and display scale.</summary>
    public void Prepare()
    {
        _palette = Palette.For(WindowsTheme.AppsAreDark);
        _pointer?.Dispose();
        _square?.Dispose();
        _pointer = Icons.Bitmap("pointer", _palette.Error, (int)Math.Round(18 * Dpi), 2.1);
        _square = Icons.Bitmap("stop", "#FFFFFF", (int)Math.Round(14 * Dpi), 2.4);
        BackColor = Palette.Drawing(_palette.Card);
        Size = new Size((int)(390 * Dpi), (int)(60 * Dpi));
        _button = new Rectangle(Width - (int)(92 * Dpi), (int)(13 * Dpi), (int)(80 * Dpi), (int)(34 * Dpi));
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        Win32.SetWindowDisplayAffinity(Handle, Win32.WdaExcludeFromCapture);
        StyleFrame();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        var s = Dpi;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.Clear(Palette.Drawing(_palette.Card));
        if (!WindowsTheme.HasRoundedWindows)
        {
            using var edge = new Pen(Palette.Drawing(_palette.ErrorDot), 2 * s);
            g.DrawRectangle(edge, s, s, Width - (2 * s), Height - (2 * s));
        }

        var tile = new RectangleF(12 * s, 12 * s, 36 * s, 36 * s);
        using (var path = Drawing.Rounded(tile, 10 * s))
        using (var soft = new SolidBrush(Palette.Drawing(_palette.ErrorSoft)))
        {
            g.FillPath(soft, path);
        }

        if (_pointer is not null)
        {
            g.DrawImage(_pointer, tile.X + ((tile.Width - _pointer.Width) / 2), tile.Y + ((tile.Height - _pointer.Height) / 2));
        }

        using var title = Drawing.Font(10f, FontStyle.Bold);
        using var small = Drawing.Font(9f);
        var textX = (int)(60 * s);
        TextRenderer.DrawText(g, Title, title, new Point(textX, (int)(12 * s)), Palette.Drawing(_palette.Text), TextFormatFlags.NoPadding);
        TextRenderer.DrawText(g, $"{_stopKey()} stops it", small, new Point(textX, (int)(33 * s)), Palette.Drawing(_palette.Subtle), TextFormatFlags.NoPadding);

        using (var path = Drawing.Rounded(_button, 8 * s))
        using (var red = new SolidBrush(Palette.Drawing(_palette.ErrorDot, _hover ? 225 : 255)))
        {
            g.FillPath(red, path);
        }

        using var label = Drawing.Font(9.75f, FontStyle.Bold);
        var labelSize = TextRenderer.MeasureText(g, "Stop", label, Size.Empty, TextFormatFlags.NoPadding);
        var iconW = _square?.Width ?? 0;
        var contentW = iconW + (6 * s) + labelSize.Width;
        var left = _button.X + ((_button.Width - contentW) / 2);
        if (_square is not null)
        {
            g.DrawImage(_square, left, _button.Y + ((_button.Height - _square.Height) / 2f));
        }

        TextRenderer.DrawText(g, "Stop", label, new Point((int)(left + iconW + (6 * s)), _button.Y + ((_button.Height - labelSize.Height) / 2)), Color.White, TextFormatFlags.NoPadding);
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        var hover = _button.Contains(e.Location);
        Cursor = hover ? Cursors.Hand : Cursors.Default;
        if (hover != _hover)
        {
            _hover = hover;
            Invalidate(_button);
        }
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        base.OnMouseLeave(e);
        if (_hover)
        {
            _hover = false;
            Invalidate(_button);
        }
    }

    protected override void OnMouseClick(MouseEventArgs e)
    {
        base.OnMouseClick(e);
        if (e.Button == MouseButtons.Left && _button.Contains(e.Location))
        {
            _stop();
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _pointer?.Dispose();
            _square?.Dispose();
        }

        base.Dispose(disposing);
    }

    /// <summary>Windows 11: rounded corners and a red DWM border (Windows 10 gets the painted edge).</summary>
    private void StyleFrame()
    {
        if (!IsHandleCreated || !WindowsTheme.HasRoundedWindows)
        {
            return;
        }

        WindowsTheme.SetCorners(Handle, WindowsTheme.Corners.Round);
        var (r, g, b) = Palette.Rgb(_palette.ErrorDot);
        WindowsTheme.SetBorderColor(Handle, r, g, b);
    }
}
