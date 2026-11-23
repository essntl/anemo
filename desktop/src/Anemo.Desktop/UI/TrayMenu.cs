using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Linq;
using System.Windows.Forms;
using Anemo.Desktop.Core;
using Anemo.Desktop.Platform;

namespace Anemo.Desktop.UI;

/// <summary>Fonts and rounded shapes for the WinForms parts (the tray menu and the indicator).</summary>
internal static class Drawing
{
    private static readonly string Family = FontFamily.Families.Any(f => f.Name == "Segoe UI Variable Text") ? "Segoe UI Variable Text" : "Segoe UI";

    public static Font Font(float points, FontStyle style = FontStyle.Regular) => new(Family, points, style, GraphicsUnit.Point);

    public static GraphicsPath Rounded(RectangleF r, float radius)
    {
        var d = radius * 2;
        var path = new GraphicsPath();
        path.AddArc(r.X, r.Y, d, d, 180, 90);
        path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    /// <summary>A status chip: a dot and a word on a soft colour. Returns its width.</summary>
    public static float Chip(Graphics g, Palette p, StatusTone tone, string text, Font font, float x, float y, float scale)
    {
        var (soft, ink, dot) = p.Tone(tone);
        var size = TextRenderer.MeasureText(g, text, font, Size.Empty, TextFormatFlags.NoPadding);
        var box = new RectangleF(x, y, (8 + 8 + 6 + 10) * scale + size.Width, size.Height + (6 * scale));
        using (var path = Rounded(box, 7 * scale))
        using (var fill = new SolidBrush(Palette.Drawing(soft)))
        {
            g.FillPath(fill, path);
        }

        using (var dotBrush = new SolidBrush(Palette.Drawing(dot)))
        {
            g.FillEllipse(dotBrush, x + (8 * scale), y + ((box.Height - (7 * scale)) / 2), 7 * scale, 7 * scale);
        }

        TextRenderer.DrawText(g, text, font, new Point((int)(x + (21 * scale)), (int)(y + (3 * scale))), Palette.Drawing(ink), TextFormatFlags.NoPadding);
        return box.Width;
    }
}

/// <summary>
/// The tray menu in the Anemo look: a card-coloured menu with an Anemo header that shows the
/// status, line icons, a grey hover, shortcuts in a quieter colour and the check on the right.
/// It follows the taskbar's light or dark mode, read when the menu opens.
/// </summary>
internal sealed class TrayMenu
{
    private readonly ContextMenuStrip _menu = new();
    private readonly TrayMenuRenderer _renderer = new();
    private readonly TrayMenuHeader _header = new();
    private readonly Dictionary<ToolStripItem, string> _icons = new();

    public TrayMenu()
    {
        _menu.Renderer = _renderer;
        _menu.ShowImageMargin = true;
        _menu.ShowCheckMargin = false;
        _menu.Padding = new Padding(4, 4, 4, 4);
        _menu.Font = Drawing.Font(9.75f);
        _menu.Items.Add(_header);
        _menu.Items.Add(new ToolStripSeparator());
        _menu.Opening += (_, _) =>
        {
            BeforeOpen?.Invoke();
            Theme();
        };
        _menu.Opened += (_, _) => Round();
    }

    public ContextMenuStrip Strip => _menu;

    /// <summary>Runs when the menu opens, before its icons are drawn (update texts and icons here).</summary>
    public Action? BeforeOpen { get; set; }

    /// <summary>The status line under "Anemo Desktop".</summary>
    public StatusSummary Status
    {
        get => _header.Status;
        set
        {
            _header.Status = value;
            _header.Invalidate();
        }
    }

    public void Add(ToolStripItem item, string icon)
    {
        item.Padding = new Padding(0, 5, 16, 5);
        item.ImageScaling = ToolStripItemImageScaling.None;
        _icons[item] = icon;
        _menu.Items.Add(item);
    }

    /// <summary>Changes an item's icon (drawn when the menu next opens).</summary>
    public void SetIcon(ToolStripItem item, string icon) => _icons[item] = icon;

    public void AddSeparator() => _menu.Items.Add(new ToolStripSeparator());

    private void Theme()
    {
        var palette = Palette.For(WindowsTheme.TaskbarIsDark);
        _renderer.Palette = palette;
        _header.Palette = palette;
        var scale = _menu.DeviceDpi / 96f;
        var px = (int)Math.Round(16 * scale);
        _menu.ImageScalingSize = new Size(px, px);
        foreach (var (item, icon) in _icons)
        {
            var old = item.Image;
            item.Image = Icons.Bitmap(icon, palette.Muted, px);
            old?.Dispose();
        }

        _renderer.Check?.Dispose();
        _renderer.Check = Icons.Bitmap("check", palette.Accent, px, 2.4);
    }

    private void Round()
    {
        if (WindowsTheme.HasRoundedWindows)
        {
            WindowsTheme.SetCorners(_menu.Handle, WindowsTheme.Corners.Round);
            var (r, g, b) = Palette.Rgb(_renderer.Palette.Edge);
            WindowsTheme.SetBorderColor(_menu.Handle, r, g, b);
        }
    }
}

/// <summary>Draws the tray menu with the <see cref="Palette"/> colours.</summary>
internal sealed class TrayMenuRenderer : ToolStripRenderer
{
    public Palette Palette { get; set; } = Palette.Light;

    /// <summary>How far icons and labels sit in from the menu's edge, at 100 % scale.</summary>
    private const int Indent = 8;

    /// <summary>The check drawn at the right of a checked item.</summary>
    public Bitmap? Check { get; set; }

    protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e) => e.Graphics.Clear(Palette.Drawing(Palette.Card));

    protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e)
    {
        if (!WindowsTheme.HasRoundedWindows)
        {
            using var pen = new Pen(Palette.Drawing(Palette.Edge));
            e.Graphics.DrawRectangle(pen, 0, 0, e.AffectedBounds.Width - 1, e.AffectedBounds.Height - 1);
        }
    }

    protected override void OnRenderImageMargin(ToolStripRenderEventArgs e)
    {
    }

    protected override void OnRenderItemCheck(ToolStripItemImageRenderEventArgs e)
    {
    }

    protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var scale = e.ToolStrip?.DeviceDpi / 96f ?? 1;
        if (e.Item.Selected && e.Item.Enabled)
        {
            var box = new RectangleF(2 * scale, 0, e.Item.Width - (4 * scale), e.Item.Height);
            using var path = Drawing.Rounded(box, 6 * scale);
            using var fill = new SolidBrush(Palette.Drawing(Palette.Inset));
            g.FillPath(fill, path);
        }

        if (e.Item is ToolStripMenuItem { Checked: true } && Check is not null)
        {
            g.DrawImage(Check, e.Item.Width - Check.Width - (12 * scale), (e.Item.Height - Check.Height) / 2f);
        }
    }

    protected override void OnRenderItemImage(ToolStripItemImageRenderEventArgs e)
    {
        if (e.Image is not null)
        {
            var scale = e.ToolStrip?.DeviceDpi / 96f ?? 1;
            e.Graphics.DrawImage(e.Image, e.ImageRectangle.X + (Indent * scale), e.ImageRectangle.Y);
        }
    }

    protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
    {
        var shortcut = e.Item is ToolStripMenuItem item && !string.IsNullOrEmpty(item.ShortcutKeyDisplayString) && e.Text == item.ShortcutKeyDisplayString;
        e.TextColor = Palette.Drawing(shortcut ? Palette.Subtle : (e.Item.Enabled ? Palette.Text : Palette.Subtle));
        if (!shortcut)
        {
            var scale = e.ToolStrip?.DeviceDpi / 96f ?? 1;
            var r = e.TextRectangle;
            e.TextRectangle = new Rectangle(r.X + (int)((Indent + 4) * scale), r.Y, r.Width, r.Height);
        }

        base.OnRenderItemText(e);
    }

    protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e)
    {
        var scale = e.ToolStrip?.DeviceDpi / 96f ?? 1;
        var y = e.Item.Height / 2;
        using var pen = new Pen(Palette.Drawing(Palette.Dark ? "#FFFFFF" : "#0F141E", 22));
        e.Graphics.DrawLine(pen, 8 * scale, y, e.Item.Width - (8 * scale), y);
    }

    protected override void OnRenderArrow(ToolStripArrowRenderEventArgs e)
    {
    }
}

/// <summary>
/// The top of the tray menu: the Anemo tile, "Anemo Desktop" and the status chip. A menu item
/// (so it spans the whole width) that can't be selected and draws itself.
/// </summary>
internal sealed class TrayMenuHeader : ToolStripMenuItem
{
    private Bitmap? _logo;
    private int _logoPx;
    private bool _logoDark;

    public TrayMenuHeader()
    {
        Enabled = true;
        AutoSize = false;
    }

    public StatusSummary Status { get; set; } = new(StatusTone.Neutral, "Starting", "");

    public Palette Palette { get; set; } = Palette.Light;

    public override bool CanSelect => false;

    protected override void OnClick(EventArgs e)
    {
    }

    public override Size GetPreferredSize(Size constrainingSize)
    {
        var scale = Owner?.DeviceDpi / 96f ?? 1;
        return new Size((int)(300 * scale), (int)(58 * scale));
    }

    protected override void OnOwnerChanged(EventArgs e)
    {
        base.OnOwnerChanged(e);
        Size = GetPreferredSize(Size.Empty);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        var scale = Owner?.DeviceDpi / 96f ?? 1;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var px = (int)Math.Round(32 * scale);
        if (_logo is null || _logoPx != px || _logoDark != Palette.Dark)
        {
            _logo?.Dispose();
            _logo = Icons.Logo(px, Palette.Dark);
            _logoDark = Palette.Dark;
            _logoPx = px;
        }

        var x = 10 * scale;
        g.DrawImage(_logo, x, (Height - px) / 2f);
        using var title = Drawing.Font(10.5f, FontStyle.Bold);
        using var small = Drawing.Font(8.25f, FontStyle.Bold);
        var textX = (int)(x + px + (12 * scale));
        TextRenderer.DrawText(g, "Anemo Desktop", title, new Point(textX, (int)(9 * scale)), Palette.Drawing(Palette.Text), TextFormatFlags.NoPadding);
        Drawing.Chip(g, Palette, Status.Tone, Status.Title, small, textX, 31 * scale, scale);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _logo?.Dispose();
        }

        base.Dispose(disposing);
    }
}
