using Anemo.Desktop.Core.Commands;

namespace Anemo.Desktop.Core.Platform;

/// <summary>
/// Core's keys (Windows virtual-key codes, <see cref="KeyParser"/>) as macOS key codes and
/// modifier flags for CGEvent. Key codes are positions on the keyboard (US layout), as Carbon's
/// <c>kVK_*</c> constants; with another layout a letter key types that layout's letter, and
/// Cmd shortcuts work as with the US layout (macOS's own rule).
/// </summary>
public static class MacKeyCodes
{
    public const ulong FlagShift = 0x20000; // kCGEventFlagMaskShift
    public const ulong FlagControl = 0x40000; // kCGEventFlagMaskControl
    public const ulong FlagOption = 0x80000; // kCGEventFlagMaskAlternate
    public const ulong FlagCommand = 0x100000; // kCGEventFlagMaskCommand

    public const ushort Command = 0x37;
    public const ushort Shift = 0x38;
    public const ushort Option = 0x3A;
    public const ushort Control = 0x3B;

    private static readonly Dictionary<ushort, ushort> Keys = new()
    {
        [0x0D] = 0x24, // Enter → Return
        [0x1B] = 0x35, // Escape
        [0x09] = 0x30, // Tab
        [0x08] = 0x33, // Backspace → Delete
        [0x2E] = 0x75, // Delete → Forward Delete
        [0x20] = 0x31, // Space
        [0x24] = 0x73, // Home
        [0x23] = 0x77, // End
        [0x21] = 0x74, // PageUp
        [0x22] = 0x79, // PageDown
        [0x26] = 0x7E, // ArrowUp
        [0x28] = 0x7D, // ArrowDown
        [0x25] = 0x7B, // ArrowLeft
        [0x27] = 0x7C, // ArrowRight
        ['A'] = 0x00, ['S'] = 0x01, ['D'] = 0x02, ['F'] = 0x03, ['H'] = 0x04, ['G'] = 0x05,
        ['Z'] = 0x06, ['X'] = 0x07, ['C'] = 0x08, ['V'] = 0x09, ['B'] = 0x0B, ['Q'] = 0x0C,
        ['W'] = 0x0D, ['E'] = 0x0E, ['R'] = 0x0F, ['Y'] = 0x10, ['T'] = 0x11, ['O'] = 0x1F,
        ['U'] = 0x20, ['I'] = 0x22, ['P'] = 0x23, ['L'] = 0x25, ['J'] = 0x26, ['K'] = 0x28,
        ['N'] = 0x2D, ['M'] = 0x2E,
        ['1'] = 0x12, ['2'] = 0x13, ['3'] = 0x14, ['4'] = 0x15, ['5'] = 0x17, ['6'] = 0x16,
        ['7'] = 0x1A, ['8'] = 0x1C, ['9'] = 0x19, ['0'] = 0x1D,
    };

    /// <summary>The macOS key code of a Core key, or null when the Mac has no such key.</summary>
    public static ushort? KeyCode(ushort virtualKey) => Keys.TryGetValue(virtualKey, out var code) ? code : null;

    /// <summary>The modifier's macOS key code (Win/Meta/Cmd → Command, Alt → Option).</summary>
    public static ushort ModifierKeyCode(ushort virtualKey) => virtualKey switch
    {
        KeyParser.VkControl => Control,
        KeyParser.VkShift => Shift,
        KeyParser.VkAlt => Option,
        _ => Command,
    };

    /// <summary>The CGEvent flags for the combo's modifiers.</summary>
    public static ulong Flags(KeyCombo combo)
    {
        ulong flags = 0;
        foreach (var m in combo.Modifiers)
        {
            flags |= m switch
            {
                KeyParser.VkControl => FlagControl,
                KeyParser.VkShift => FlagShift,
                KeyParser.VkAlt => FlagOption,
                _ => FlagCommand,
            };
        }

        return flags;
    }
}
