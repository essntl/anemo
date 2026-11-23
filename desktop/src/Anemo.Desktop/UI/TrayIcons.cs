using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Windows.Forms;
using Anemo.Desktop.Core;

namespace Anemo.Desktop.UI;

/// <summary>
/// The tray icons, one per <see cref="TrayIcon"/>, and the app icon for windows. They are
/// .ico files embedded in the exe (Assets/, drawn by e2e/scripts/make-native-icons.cjs) with
/// an image per size, so Windows gets a sharp one at every display scale.
/// </summary>
internal sealed class TrayIcons : IDisposable
{
    private readonly Dictionary<TrayIcon, Icon> _tray = new();

    public TrayIcons()
    {
        foreach (var state in Enum.GetValues<TrayIcon>())
        {
            _tray[state] = Load($"Tray.{state}.ico", SystemInformation.SmallIconSize);
        }

        App = Load("Anemo.ico", SystemInformation.IconSize);
        using var stream = Resource("Anemo.ico");
        AppImage = new System.Windows.Media.Imaging.IconBitmapDecoder(
            stream, System.Windows.Media.Imaging.BitmapCreateOptions.None, System.Windows.Media.Imaging.BitmapCacheOption.OnLoad).Frames[0];
    }

    /// <summary>The Anemo icon, for WinForms windows and message boxes.</summary>
    public Icon App { get; }

    /// <summary>The Anemo icon for WPF windows (Windows picks the size it needs from the .ico).</summary>
    public System.Windows.Media.ImageSource AppImage { get; }

    public Icon For(TrayIcon icon) => _tray[icon];

    public void Dispose()
    {
        foreach (var icon in _tray.Values)
        {
            icon.Dispose();
        }

        App.Dispose();
    }

    private static Icon Load(string name, Size size)
    {
        using var stream = Resource(name);
        return new Icon(stream, size);
    }

    private static Stream Resource(string name) =>
        typeof(TrayIcons).Assembly.GetManifestResourceStream(name)
            ?? throw new FileNotFoundException("An icon is missing from the app.", name);
}
