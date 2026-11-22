namespace Anemo.Desktop.Core.Control;

/// <summary>RegisterHotKey modifier flags.</summary>
[Flags]
public enum HotkeyModifiers : uint
{
    None = 0,
    Alt = 0x1,
    Control = 0x2,
    Shift = 0x4,
    Win = 0x8,
}

/// <summary>A global hotkey such as <c>Ctrl+Alt+Shift+S</c> (the stop and share keys).</summary>
public sealed record Hotkey(HotkeyModifiers Modifiers, uint Key)
{
    public const string DefaultStop = "Ctrl+Alt+Shift+S";
    public const string DefaultShare = "Ctrl+Alt+Shift+A";

    /// <summary>
    /// Parses <c>Ctrl+Alt+Shift+S</c>: modifiers (<c>Ctrl</c>, <c>Alt</c>, <c>Shift</c>,
    /// <c>Win</c>) and one letter, digit or F1–F12. At least two modifiers, one of them
    /// Ctrl, Alt or Win, so ordinary typing can't trigger it. Null when it isn't valid.
    /// </summary>
    public static Hotkey? Parse(string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return null;
        }

        var parts = text.Split('+', StringSplitOptions.TrimEntries);
        var mods = HotkeyModifiers.None;
        foreach (var part in parts[..^1])
        {
            var flag = part.ToUpperInvariant() switch
            {
                "CTRL" or "CONTROL" => HotkeyModifiers.Control,
                "ALT" => HotkeyModifiers.Alt,
                "SHIFT" => HotkeyModifiers.Shift,
                "WIN" => HotkeyModifiers.Win,
                _ => HotkeyModifiers.None,
            };
            if (flag == HotkeyModifiers.None || mods.HasFlag(flag))
            {
                return null;
            }

            mods |= flag;
        }

        var count = parts.Length - 1;
        if (count < 2 || (mods & (HotkeyModifiers.Control | HotkeyModifiers.Alt | HotkeyModifiers.Win)) == 0)
        {
            return null;
        }

        var key = KeyCode(parts[^1].ToUpperInvariant());
        return key is null ? null : new Hotkey(mods, key.Value);
    }

    public override string ToString()
    {
        var parts = new List<string>();
        if (Modifiers.HasFlag(HotkeyModifiers.Control))
        {
            parts.Add("Ctrl");
        }

        if (Modifiers.HasFlag(HotkeyModifiers.Alt))
        {
            parts.Add("Alt");
        }

        if (Modifiers.HasFlag(HotkeyModifiers.Shift))
        {
            parts.Add("Shift");
        }

        if (Modifiers.HasFlag(HotkeyModifiers.Win))
        {
            parts.Add("Win");
        }

        parts.Add(Key is >= 0x70 and <= 0x7B ? $"F{Key - 0x6F}" : ((char)Key).ToString());
        return string.Join('+', parts);
    }

    private static uint? KeyCode(string key)
    {
        if (key.Length == 1 && (char.IsAsciiLetterUpper(key[0]) || char.IsAsciiDigit(key[0])))
        {
            return key[0];
        }

        if (key.Length is 2 or 3 && key[0] == 'F' && int.TryParse(key[1..], out var n) && n is >= 1 and <= 12)
        {
            return (uint)(0x6F + n);
        }

        return null;
    }
}
