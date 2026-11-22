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
        if (key == VkDelete && modifiers.Contains(VkControl) && modifiers.Contains(VkAlt))
        {
            throw CommandException.Refused("Ctrl+Alt+Del can't be pressed by the agent.");
        }

        return new KeyCombo(modifiers, key, text);
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
