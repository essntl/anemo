using Anemo.Desktop.Core.Commands;
using Anemo.Desktop.Core.Platform;
using Anemo.Desktop.Mac.Native;

namespace Anemo.Desktop.Mac.Platform;

/// <summary>
/// Mouse and keyboard by CGEvent (needs the Accessibility permission). Points are global
/// display points, as Core gives them (docs/specs/09-desktop-macos.md D4). Text is typed as
/// Unicode, so it doesn't depend on the keyboard layout; keys go by their key code
/// (<see cref="MacKeyCodes"/>).
/// </summary>
internal sealed class MacInput : IInput
{
    private const int LinesPerStep = 3;
    private static readonly TimeSpan Gap = TimeSpan.FromMilliseconds(8);

    public void Click(ScreenPoint at, MouseButton button, int count)
    {
        RequireAccessibility();
        var point = new CGPoint(at.X, at.Y);
        var (down, up, cgButton) = button == MouseButton.Right
            ? (CG.RightMouseDown, CG.RightMouseUp, 1)
            : (CG.LeftMouseDown, CG.LeftMouseUp, 0);
        Post(CG.MouseEvent(0, CG.MouseMoved, point, 0));
        Thread.Sleep(Gap);
        for (var i = 1; i <= count; i++)
        {
            // The click state (1, 2) is what makes macOS see a double click.
            Post(CG.MouseEvent(0, down, point, cgButton), e => CG.SetField(e, CG.MouseEventClickState, i));
            Post(CG.MouseEvent(0, up, point, cgButton), e => CG.SetField(e, CG.MouseEventClickState, i));
            Thread.Sleep(Gap);
        }
    }

    public void TypeText(string text, CancellationToken ct)
    {
        RequireAccessibility();
        var units = System.Globalization.StringInfo.GetTextElementEnumerator(text);
        while (units.MoveNext())
        {
            ct.ThrowIfCancellationRequested();
            var unit = (string)units.Current;
            if (unit is "\n" or "\r\n" or "\r")
            {
                Key(0x24, 0); // Return
            }
            else if (unit == "\t")
            {
                Key(0x30, 0); // Tab
            }
            else
            {
                foreach (var down in new[] { true, false })
                {
                    Post(CG.KeyEvent(0, 0, down), e => CG.SetUnicode(e, (nuint)unit.Length, unit));
                }
            }

            Thread.Sleep(Gap);
        }
    }

    public void Press(KeyCombo combo)
    {
        RequireAccessibility();
        var key = MacKeyCodes.KeyCode(combo.Key) ?? throw CommandException.Failed($"The Mac has no key for “{combo.Text}”.");
        var flags = MacKeyCodes.Flags(combo);
        ulong held = 0;
        foreach (var modifier in combo.Modifiers)
        {
            held |= MacKeyCodes.Flags(combo with { Modifiers = [modifier] });
            var flagsNow = held;
            Post(CG.KeyEvent(0, MacKeyCodes.ModifierKeyCode(modifier), true), e => CG.SetFlags(e, flagsNow));
        }

        Key(key, flags);
        foreach (var modifier in combo.Modifiers.Reverse())
        {
            held &= ~MacKeyCodes.Flags(combo with { Modifiers = [modifier] });
            var flagsNow = held;
            Post(CG.KeyEvent(0, MacKeyCodes.ModifierKeyCode(modifier), false), e => CG.SetFlags(e, flagsNow));
        }
    }

    public void Scroll(ScreenPoint? at, ScrollDirection direction, int amount)
    {
        RequireAccessibility();
        var lines = amount * LinesPerStep;
        var (vertical, horizontal) = direction switch
        {
            ScrollDirection.Up => (lines, 0),
            ScrollDirection.Down => (-lines, 0),
            ScrollDirection.Left => (0, lines),
            _ => (0, -lines),
        };
        if (at is { } p)
        {
            Post(CG.MouseEvent(0, CG.MouseMoved, new CGPoint(p.X, p.Y), 0));
            Thread.Sleep(Gap);
        }

        Post(CG.ScrollEvent(0, CG.ScrollUnitLine, 2, vertical, horizontal, 0));
    }

    private static void Key(ushort code, ulong flags)
    {
        Post(CG.KeyEvent(0, code, true), e => CG.SetFlags(e, flags));
        Post(CG.KeyEvent(0, code, false), e => CG.SetFlags(e, flags));
    }

    private static void Post(nint evt, Action<nint>? prepare = null)
    {
        if (evt == 0)
        {
            throw CommandException.Unavailable("macOS didn't make the input event.");
        }

        try
        {
            prepare?.Invoke(evt);
            CG.Post(CG.HidEventTap, evt);
        }
        finally
        {
            CF.Release(evt);
        }
    }

    public const string NoAccessibilityMessage =
        "Anemo Desktop isn't allowed to control this Mac (Accessibility). Ask the user to allow it: Anemo Desktop's menu → Permissions…, or System Settings → Privacy & Security → Accessibility.";

    /// <summary>Without Accessibility macOS drops the events silently: say so instead.</summary>
    private static void RequireAccessibility()
    {
        if (!AX.IsTrusted())
        {
            throw CommandException.Unavailable(NoAccessibilityMessage);
        }
    }
}
