using Anemo.Desktop.Core.Control;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Threading;

namespace Anemo.Desktop.Mac.UI;

/// <summary>The menu bar and window icons: the Windows client's .ico files, embedded.</summary>
internal static class Icons
{
    private static readonly Dictionary<Core.TrayIcon, WindowIcon> Cache = new();

    public static WindowIcon Tray(Core.TrayIcon state)
    {
        if (!Cache.TryGetValue(state, out var icon))
        {
            icon = Load($"Tray.{state}.ico");
            Cache[state] = icon;
        }

        return icon;
    }

    public static WindowIcon App => Load("Anemo.ico");

    private static WindowIcon Load(string name)
    {
        using var stream = typeof(Icons).Assembly.GetManifestResourceStream(name)
            ?? throw new InvalidOperationException($"The icon {name} isn't embedded.");
        return new WindowIcon(stream);
    }
}

/// <summary>Key combinations as a Mac shows them: Ctrl+Alt+Shift+S → ⌃⌥⇧S.</summary>
internal static class MacKeyNames
{
    public static string Show(Hotkey hotkey)
    {
        var text = "";
        if (hotkey.Modifiers.HasFlag(HotkeyModifiers.Control))
        {
            text += "⌃";
        }

        if (hotkey.Modifiers.HasFlag(HotkeyModifiers.Alt))
        {
            text += "⌥";
        }

        if (hotkey.Modifiers.HasFlag(HotkeyModifiers.Shift))
        {
            text += "⇧";
        }

        if (hotkey.Modifiers.HasFlag(HotkeyModifiers.Win))
        {
            text += "⌘";
        }

        var key = hotkey.ToString().Split('+')[^1];
        return text + key;
    }

    public static string Show(string text) => Hotkey.Parse(text) is { } hotkey ? Show(hotkey) : text;
}

/// <summary>
/// A short message at the top right for a few seconds (what a balloon is on Windows). macOS
/// notifications would need the user's permission too; this needs none.
/// </summary>
internal static class Notice
{
    private static Window? _current;

    public static void Show(string text)
    {
        _current?.Close();
        var window = new Window
        {
            SystemDecorations = SystemDecorations.None,
            Topmost = true,
            ShowActivated = false,
            ShowInTaskbar = false,
            CanResize = false,
            SizeToContent = SizeToContent.WidthAndHeight,
            Background = new SolidColorBrush(Color.FromRgb(0x1f, 0x23, 0x2b)),
            Content = new TextBlock
            {
                Text = text,
                Foreground = Brushes.White,
                TextWrapping = TextWrapping.Wrap,
                MaxWidth = 360,
                Margin = new Thickness(16, 12),
            },
        };
        _current = window;
        window.Opened += (_, _) => PlaceTopRight(window);
        window.Show();
        DispatcherTimer.RunOnce(() =>
        {
            window.Close();
            if (_current == window)
            {
                _current = null;
            }
        }, TimeSpan.FromSeconds(6));
    }

    /// <summary>Puts the window in the top-right corner of the main screen, below the menu bar.</summary>
    public static void PlaceTopRight(Window window)
    {
        if (window.Screens.Primary is { } screen)
        {
            var area = screen.WorkingArea;
            var width = (int)(window.Bounds.Width * screen.Scaling);
            window.Position = new PixelPoint(area.Right - width - 16, area.Y + 12);
        }
    }
}

/// <summary>"Anemo is using this computer" with Stop, top right, while a command runs.</summary>
internal sealed class IndicatorWindow : Window
{
    private readonly Func<string> _stopKey;
    private readonly TextBlock _hint = new() { Foreground = Brushes.White, Opacity = 0.8, FontSize = 11 };

    public IndicatorWindow(Action stop, Func<string> stopKey)
    {
        _stopKey = stopKey;
        SystemDecorations = SystemDecorations.None;
        Topmost = true;
        ShowActivated = false;
        ShowInTaskbar = false;
        CanResize = false;
        SizeToContent = SizeToContent.WidthAndHeight;
        Background = new SolidColorBrush(Color.FromRgb(0xdc, 0x3b, 0x3b));
        var button = new Button { Content = "Stop", VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(12, 0, 0, 0) };
        button.Click += (_, _) => stop();
        Content = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            Margin = new Thickness(14, 8),
            Children =
            {
                new StackPanel
                {
                    Children =
                    {
                        new TextBlock { Text = "Anemo is using this computer", Foreground = Brushes.White, FontWeight = FontWeight.SemiBold },
                        _hint,
                    },
                },
                button,
            },
        };
        Opened += (_, _) => Notice.PlaceTopRight(this);
    }

    public void ShowInCorner()
    {
        _hint.Text = $"Stop: {MacKeyNames.Show(_stopKey())}";
        if (!IsVisible)
        {
            Show();
        }
    }
}
