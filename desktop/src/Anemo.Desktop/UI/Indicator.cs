using System;
using System.Drawing;
using System.Windows.Forms;
using Anemo.Desktop.Platform;

namespace Anemo.Desktop.UI;

/// <summary>
/// "Anemo is using this computer" with a Stop button, always on top in the corner of the
/// screen while a command runs. It never takes the focus (the agent may be typing) and is
/// left out of screenshots.
/// </summary>
internal sealed class Indicator : Form
{
    private static readonly Color Red = Color.FromArgb(220, 38, 38);

    public Indicator(Action stop)
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        AutoScaleMode = AutoScaleMode.Dpi;
        BackColor = Color.White;
        Padding = new Padding(3);
        Size = new Size(340, 44);
        Text = "Anemo is using this computer";

        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, BackColor = Color.White };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        var label = new Label
        {
            Text = "Anemo is using this computer",
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleLeft,
            ForeColor = Red,
            Font = new Font(SystemFonts.MessageBoxFont ?? DefaultFont, FontStyle.Bold),
        };
        var button = new Button { Text = "Stop", AutoSize = true, Anchor = AnchorStyles.Right };
        button.Click += (_, _) => stop();
        layout.Controls.Add(label, 0, 0);
        layout.Controls.Add(button, 1, 0);
        Controls.Add(layout);
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

    public void ShowInCorner()
    {
        var area = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1024, 768);
        Location = new Point(area.Right - Width - 12, area.Bottom - Height - 12);
        if (!Visible)
        {
            Show();
        }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        Win32.SetWindowDisplayAffinity(Handle, Win32.WdaExcludeFromCapture);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        using var pen = new Pen(Red, 3);
        e.Graphics.DrawRectangle(pen, 1, 1, Width - 3, Height - 3);
    }
}
