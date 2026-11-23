using System;
using System.Globalization;
using Anemo.Desktop.Core;

namespace Anemo.Desktop.UI;

/// <summary>
/// The colours of the web app's redesign (frontend/src/styles/tokens.css and the "Native apps v2"
/// Figma page), for the Settings window, the tray menu and the indicator. Hex strings, "#RRGGBB".
/// </summary>
internal sealed record Palette(
    bool Dark,
    string Ground,
    string Card,
    string Inset,
    string Raised,
    string Field,
    string Edge,
    string Text,
    string Muted,
    string Subtle,
    string Accent,
    string OnAccent,
    string AccentSoft,
    string Ok,
    string OkDot,
    string OkSoft,
    string Warn,
    string WarnDot,
    string WarnSoft,
    string Error,
    string ErrorDot,
    string ErrorSoft,
    string Switch)
{
    public static readonly Palette Light = new(
        false, "#ECEEF2", "#FFFFFF", "#E4E7ED", "#FFFFFF", "#FFFFFF", "#DCDFE4", "#14161A", "#3D434E", "#555C69",
        "#2A6DF4", "#FFFFFF", "#E3ECFE", "#1A7F47", "#1F9D55", "#E3F4EA", "#B45309", "#D97706", "#FCF0DE",
        "#C42B2B", "#DC3B3B", "#FCE8E8", "#CFD3DA");

    public static readonly Palette DarkTheme = new(
        true, "#0B0C10", "#16181D", "#22262D", "#2C3038", "#1E2127", "#30343C", "#ECEEF2", "#BCC2CD", "#A0A7B4",
        "#6A9DFF", "#0B1220", "#1F2C45", "#3CCF7A", "#3CCF7A", "#173126", "#F2A93B", "#F2A93B", "#3A2C17",
        "#F06464", "#F06464", "#3D2023", "#3A3F48");

    /// <summary>The dark tile behind the Anemo mark, the same in both themes.</summary>
    public const string Tile = "#15181E";

    public static Palette For(bool dark) => dark ? DarkTheme : Light;

    /// <summary>The soft background, the text and the dot colour of a status chip.</summary>
    public (string Soft, string Text, string Dot) Tone(StatusTone tone) => tone switch
    {
        StatusTone.Ok => (OkSoft, Ok, OkDot),
        StatusTone.Warn => (WarnSoft, Warn, WarnDot),
        StatusTone.Error => (ErrorSoft, Error, ErrorDot),
        _ => (Inset, Muted, Subtle),
    };

    public static (byte R, byte G, byte B) Rgb(string hex)
    {
        if (hex.Length != 7 || hex[0] != '#')
        {
            throw new ArgumentException("Expected #RRGGBB.", nameof(hex));
        }

        byte Part(int i) => byte.Parse(hex.AsSpan(i, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
        return (Part(1), Part(3), Part(5));
    }

    public static System.Drawing.Color Drawing(string hex, int alpha = 255)
    {
        var (r, g, b) = Rgb(hex);
        return System.Drawing.Color.FromArgb(alpha, r, g, b);
    }

    public static System.Windows.Media.Color Media(string hex, byte alpha = 255)
    {
        var (r, g, b) = Rgb(hex);
        return System.Windows.Media.Color.FromArgb(alpha, r, g, b);
    }
}
