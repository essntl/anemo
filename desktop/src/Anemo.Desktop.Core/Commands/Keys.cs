namespace Anemo.Desktop.Core.Commands;

/// <summary>One key with its modifiers, as Windows virtual-key codes.</summary>
public sealed record KeyCombo(IReadOnlyList<ushort> Modifiers, ushort Key, string Text)
{
    /// <summary>Keys that need KEYEVENTF_EXTENDEDKEY in SendInput.</summary>
    public static bool IsExtended(ushort vk) => vk is
        0x21 or 0x22 or 0x23 or 0x24 or 0x25 or 0x26 or 0x27 or 0x28 or 0x2E or 0x5B;
}

/// <summary>
/// Key names of companion-contracts.md §7a (<c>Enter</c>, <c>Control+a</c>, …) plus
/// <c>Win</c> as a modifier, to virtual-key codes. Anything else is refused.
/// </summary>
public static class KeyParser
{
    public const ushort VkControl = 0x11;
    public const ushort VkShift = 0x10;
    public const ushort VkAlt = 0x12;
    public const ushort VkWin = 0x5B;
    public const ushort VkDelete = 0x2E;
    public const ushort VkEnd = 0x23;
    public const ushort VkSpace = 0x20;
    public const ushort VkInsert = 0x2D;
    public const ushort VkV = 0x56;

    private static readonly Dictionary<string, ushort> Named = new(StringComparer.Ordinal)
    {
        ["Enter"] = 0x0D,
        ["Escape"] = 0x1B,
        ["Tab"] = 0x09,
        ["Backspace"] = 0x08,
        ["Delete"] = VkDelete,
        ["Space"] = 0x20,
        ["Home"] = 0x24,
        ["End"] = 0x23,
        ["PageUp"] = 0x21,
        ["PageDown"] = 0x22,
        ["ArrowUp"] = 0x26,
        ["ArrowDown"] = 0x28,
        ["ArrowLeft"] = 0x25,
        ["ArrowRight"] = 0x27,
    };

    private static readonly Dictionary<string, ushort> ModifierKeys = new(StringComparer.Ordinal)
    {
        ["Control"] = VkControl,
        ["Shift"] = VkShift,
        ["Alt"] = VkAlt,
        ["Meta"] = VkWin,
        ["Win"] = VkWin,
    };

    /// <summary>The combo, or throws a <see cref="CommandException"/> (failed or refused).</summary>
    public static KeyCombo Parse(string text)
    {
        var parts = text.Split('+');
        if (parts.Any(p => p.Length == 0))
        {
            throw CommandException.Failed($"Unknown key “{text}”.");
        }

        var modifiers = new List<ushort>();
        foreach (var part in parts[..^1])
        {
            if (!ModifierKeys.TryGetValue(part, out var vk))
            {
                throw CommandException.Failed($"Unknown modifier “{part}” in “{text}”.");
            }

            if (modifiers.Contains(vk))
            {
                throw CommandException.Failed($"“{part}” is given twice in “{text}”.");
            }

            modifiers.Add(vk);
        }

        var key = KeyCode(parts[^1]) ?? throw CommandException.Failed($"Unknown key “{parts[^1]}” in “{text}”.");
        // Ctrl+Alt+End is Ctrl+Alt+Del inside a remote desktop session.
        if (key is VkDelete or VkEnd && modifiers.Contains(VkControl) && modifiers.Contains(VkAlt))
        {
            throw CommandException.Refused("Ctrl+Alt+Del (or Ctrl+Alt+End) can't be pressed by the agent.");
        }

        return new KeyCombo(modifiers, key, text);
    }

    /// <summary>
    /// True when the combo puts text into a field: a letter or digit (Shift allowed, no
    /// Control, Alt or Win), Space, or a paste (Control+v, Shift+Insert).
    /// </summary>
    public static bool EntersText(KeyCombo combo)
    {
        var commandModifier = combo.Modifiers.Any(m => m is VkControl or VkAlt or VkWin);
        var letterOrDigit = combo.Key is (>= 0x41 and <= 0x5A) or (>= 0x30 and <= 0x39);
        if ((letterOrDigit || combo.Key == VkSpace) && !commandModifier)
        {
            return true;
        }

        var paste = (combo.Key == VkV && combo.Modifiers.Contains(VkControl))
            || (combo.Key == VkInsert && combo.Modifiers.Contains(VkShift));
        return paste;
    }

    /// <summary>The combo's modifiers as hotkey flags (to compare with the client's own keys).</summary>
    public static Control.HotkeyModifiers HotkeyModifiersOf(KeyCombo combo)
    {
        var flags = Control.HotkeyModifiers.None;
        foreach (var m in combo.Modifiers)
        {
            flags |= m switch
            {
                VkControl => Control.HotkeyModifiers.Control,
                VkAlt => Control.HotkeyModifiers.Alt,
                VkShift => Control.HotkeyModifiers.Shift,
                _ => Control.HotkeyModifiers.Win,
            };
        }

        return flags;
    }

    private static ushort? KeyCode(string name)
    {
        if (Named.TryGetValue(name, out var vk))
        {
            return vk;
        }

        if (name.Length == 1)
        {
            var c = name[0];
            if (c is >= 'a' and <= 'z')
            {
                return (ushort)('A' + (c - 'a'));
            }

            if (c is >= '0' and <= '9')
            {
                return c;
            }
        }

        return null;
    }
}
