using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using Anemo.Desktop.Core.Control;

namespace Anemo.Desktop.UI;

/// <summary>A line icon from <see cref="Icons"/>: <c>&lt;ui:LineIcon Kind="folder" Size="16" Stroke="…"/&gt;</c>.</summary>
internal sealed class LineIcon : FrameworkElement
{
    public static readonly DependencyProperty KindProperty = DependencyProperty.Register(
        nameof(Kind), typeof(string), typeof(LineIcon), new FrameworkPropertyMetadata(null, FrameworkPropertyMetadataOptions.AffectsRender));

    public static readonly DependencyProperty StrokeProperty = DependencyProperty.Register(
        nameof(Stroke), typeof(Brush), typeof(LineIcon), new FrameworkPropertyMetadata(Brushes.Gray, FrameworkPropertyMetadataOptions.AffectsRender));

    public static readonly DependencyProperty SizeProperty = DependencyProperty.Register(
        nameof(Size), typeof(double), typeof(LineIcon), new FrameworkPropertyMetadata(16.0, FrameworkPropertyMetadataOptions.AffectsMeasure));

    public string? Kind
    {
        get => (string?)GetValue(KindProperty);
        set => SetValue(KindProperty, value);
    }

    public Brush Stroke
    {
        get => (Brush)GetValue(StrokeProperty);
        set => SetValue(StrokeProperty, value);
    }

    public double Size
    {
        get => (double)GetValue(SizeProperty);
        set => SetValue(SizeProperty, value);
    }

    protected override Size MeasureOverride(Size availableSize) => string.IsNullOrEmpty(Kind) ? default : new Size(Size, Size);

    protected override void OnRender(DrawingContext dc)
    {
        if (string.IsNullOrEmpty(Kind) || !Icons.Paths.ContainsKey(Kind))
        {
            return;
        }

        dc.PushTransform(new ScaleTransform(Size / 24.0, Size / 24.0));
        dc.DrawGeometry(null, Icons.Pen(Stroke, Size <= 16 ? 2.0 : 1.8), Icons.Geometry(Kind));
        dc.Pop();
    }
}

/// <summary>The Anemo mark on its dark tile (the app icon), drawn as vectors.</summary>
internal sealed class LogoTile : FrameworkElement
{
    public static readonly DependencyProperty SizeProperty = DependencyProperty.Register(
        nameof(Size), typeof(double), typeof(LogoTile), new FrameworkPropertyMetadata(36.0, FrameworkPropertyMetadataOptions.AffectsMeasure));

    /// <summary>A 1 px light edge, so the dark tile stays visible on a dark background.</summary>
    public static readonly DependencyProperty EdgeProperty = DependencyProperty.Register(
        nameof(Edge), typeof(bool), typeof(LogoTile), new FrameworkPropertyMetadata(false, FrameworkPropertyMetadataOptions.AffectsRender));

    public double Size
    {
        get => (double)GetValue(SizeProperty);
        set => SetValue(SizeProperty, value);
    }

    public bool Edge
    {
        get => (bool)GetValue(EdgeProperty);
        set => SetValue(EdgeProperty, value);
    }

    /// <summary>The mark's fade: transparent at x=1, opaque at x=13 (in the mark's own grid).</summary>
    public static Brush Fade(Color color, double from = 0) => new LinearGradientBrush(
        new GradientStopCollection
        {
            new(Color.FromArgb((byte)(from * 255), color.R, color.G, color.B), 0),
            new(color, 1),
        },
        new Point(1.75, 0),
        new Point(13.75, 0))
    {
        MappingMode = BrushMappingMode.Absolute,
    };

    protected override Size MeasureOverride(Size availableSize) => new(Size, Size);

    protected override void OnRender(DrawingContext dc)
    {
        var small = Size <= 32;
        dc.PushTransform(new ScaleTransform(Size / 24.0, Size / 24.0));
        var edge = Edge ? new Pen(new SolidColorBrush(Color.FromArgb(40, 255, 255, 255)), 24.0 / Size) : null;
        var radius = small ? 4.5 : 5.5;
        dc.DrawRoundedRectangle(new SolidColorBrush(Palette.Media(Palette.Tile)), edge, new Rect(0, 0, 24, 24), radius, radius);
        var scale = small ? 0.8 : 0.64;
        var offset = (24 - (24 * scale)) / 2;
        dc.PushTransform(new MatrixTransform(scale, 0, 0, scale, offset, offset));
        dc.DrawGeometry(null, Icons.Pen(Fade(Colors.White, small ? 0.35 : 0), small ? 2.3 : 1.7), Geometry.Parse(Icons.Mark));
        dc.Pop();
        dc.Pop();
    }
}

/// <summary>
/// A hotkey field: shows the keys as keycaps; click or tab into it and press the new keys
/// (two or more of Ctrl, Alt, Shift, Win, then a letter, digit or F1–F12). Esc keeps the old ones.
/// </summary>
internal sealed class KeyField : Border
{
    private readonly WrapPanel _caps = new() { VerticalAlignment = VerticalAlignment.Center };
    private string _keys = "";
    private bool _recording;

    public KeyField()
    {
        Focusable = true;
        Cursor = Cursors.Hand;
        MinHeight = 36;
        MinWidth = 190;
        Padding = new Thickness(6, 0, 6, 0);
        CornerRadius = new CornerRadius(8);
        BorderThickness = new Thickness(1);
        Child = _caps;
        SetResourceReference(BackgroundProperty, "Field");
        SetResourceReference(BorderBrushProperty, "Edge");
        FocusVisualStyle = null;
        KeyboardNavigation.SetIsTabStop(this, true);
    }

    /// <summary>The keys were changed by the user.</summary>
    public event Action? Changed;

    public string Keys
    {
        get => _keys;
        set
        {
            _keys = value;
            Show();
        }
    }

    /// <summary>Red edge for a problem; null clears it.</summary>
    public void SetError(bool error)
    {
        if (error)
        {
            SetResourceReference(BorderBrushProperty, "ErrorDot");
        }
        else
        {
            SetResourceReference(BorderBrushProperty, _recording ? "Accent" : "Edge");
        }
    }

    protected override void OnMouseLeftButtonDown(MouseButtonEventArgs e)
    {
        Focus();
        e.Handled = true;
    }

    protected override void OnGotKeyboardFocus(KeyboardFocusChangedEventArgs e)
    {
        base.OnGotKeyboardFocus(e);
        _recording = true;
        SetResourceReference(BorderBrushProperty, "Accent");
        Show();
    }

    protected override void OnLostKeyboardFocus(KeyboardFocusChangedEventArgs e)
    {
        base.OnLostKeyboardFocus(e);
        _recording = false;
        SetResourceReference(BorderBrushProperty, "Edge");
        Show();
    }

    protected override void OnPreviewKeyDown(KeyEventArgs e)
    {
        if (!_recording)
        {
            return;
        }

        var key = e.Key == Key.System ? e.SystemKey : e.Key;
        if (key == Key.Tab)
        {
            return; // keep Tab for moving between fields
        }

        e.Handled = true;
        if (key == Key.Escape)
        {
            Keyboard.ClearFocus();
            return;
        }

        var name = KeyName(key);
        if (name is null)
        {
            return; // a modifier on its own: wait for the key
        }

        var parts = new System.Collections.Generic.List<string>();
        var mods = Keyboard.Modifiers;
        if (mods.HasFlag(ModifierKeys.Control))
        {
            parts.Add("Ctrl");
        }

        if (mods.HasFlag(ModifierKeys.Alt))
        {
            parts.Add("Alt");
        }

        if (mods.HasFlag(ModifierKeys.Shift))
        {
            parts.Add("Shift");
        }

        if (mods.HasFlag(ModifierKeys.Windows))
        {
            parts.Add("Win");
        }

        parts.Add(name);
        var text = string.Join("+", parts);
        if (Hotkey.Parse(text) is { } hotkey)
        {
            _keys = hotkey.ToString();
            Changed?.Invoke();
            Keyboard.ClearFocus();
        }
    }

    private static string? KeyName(Key key) => key switch
    {
        >= Key.A and <= Key.Z => key.ToString(),
        >= Key.D0 and <= Key.D9 => ((char)('0' + (key - Key.D0))).ToString(),
        >= Key.NumPad0 and <= Key.NumPad9 => ((char)('0' + (key - Key.NumPad0))).ToString(),
        >= Key.F1 and <= Key.F12 => key.ToString(),
        _ => null,
    };

    private void Show()
    {
        _caps.Children.Clear();
        if (_recording)
        {
            var hint = new TextBlock { Text = "Press the new keys…", FontWeight = FontWeights.Medium, Margin = new Thickness(4, 0, 4, 0) };
            hint.SetResourceReference(TextBlock.ForegroundProperty, "Accent");
            _caps.Children.Add(hint);
            return;
        }

        foreach (var part in _keys.Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var label = new TextBlock { Text = part, FontSize = 12, FontWeight = FontWeights.SemiBold };
            label.SetResourceReference(TextBlock.ForegroundProperty, "Text");
            var cap = new Border
            {
                Child = label,
                CornerRadius = new CornerRadius(6),
                Padding = new Thickness(7, 2, 7, 3),
                Margin = new Thickness(2, 0, 2, 0),
                BorderThickness = new Thickness(1, 1, 1, 2),
            };
            cap.SetResourceReference(Border.BackgroundProperty, "Inset");
            cap.SetResourceReference(Border.BorderBrushProperty, "Edge");
            _caps.Children.Add(cap);
        }
    }
}
