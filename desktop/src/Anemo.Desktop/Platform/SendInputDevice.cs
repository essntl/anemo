using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using Anemo.Desktop.Core.Commands;
using Anemo.Desktop.Core.Platform;

namespace Anemo.Desktop.Platform;

/// <summary>Mouse and keyboard with SendInput. Coordinates are physical screen pixels.</summary>
internal sealed class SendInputDevice : IInput
{
    private const ushort VkReturn = 0x0D;
    private const ushort VkTab = 0x09;
    private const ushort VkMenu = 0x12;
    private const int WheelDelta = 120;

    public void Click(ScreenPoint at, MouseButton button, int count)
    {
        Win32.SetCursorPos(at.X, at.Y);
        Thread.Sleep(30);
        var (down, up) = button == MouseButton.Left
            ? (Win32.MouseEventFLeftDown, Win32.MouseEventFLeftUp)
            : (Win32.MouseEventFRightDown, Win32.MouseEventFRightUp);
        for (var i = 0; i < count; i++)
        {
            Send(Mouse(down, 0), Mouse(up, 0));
            Thread.Sleep(30);
        }
    }

    /// <summary>
    /// Types as Unicode characters (no keyboard layout involved), one at a time, checking
    /// the stop between characters. Line breaks and tabs are sent as keys.
    /// </summary>
    public void TypeText(string text, CancellationToken ct)
    {
        for (var i = 0; i < text.Length; i++)
        {
            ct.ThrowIfCancellationRequested();
            var c = text[i];
            switch (c)
            {
                case '\r':
                    continue;
                case '\n':
                    Tap(VkReturn);
                    break;
                case '\t':
                    Tap(VkTab);
                    break;
                default:
                    if (char.IsHighSurrogate(c) && i + 1 < text.Length)
                    {
                        Send(Unicode(c, false), Unicode(text[i + 1], false), Unicode(c, true), Unicode(text[i + 1], true));
                        i++;
                    }
                    else
                    {
                        Send(Unicode(c, false), Unicode(c, true));
                    }

                    break;
            }

            Thread.Sleep(4);
        }
    }

    public void Press(KeyCombo combo)
    {
        var inputs = new List<Win32.Input>();
        foreach (var m in combo.Modifiers)
        {
            inputs.Add(Key(m, false));
        }

        inputs.Add(Key(combo.Key, false));
        inputs.Add(Key(combo.Key, true));
        for (var i = combo.Modifiers.Count - 1; i >= 0; i--)
        {
            inputs.Add(Key(combo.Modifiers[i], true));
        }

        Send([.. inputs]);
        Thread.Sleep(30);
    }

    public void Scroll(ScreenPoint? at, ScrollDirection direction, int amount)
    {
        if (at is { } p)
        {
            Win32.SetCursorPos(p.X, p.Y);
            Thread.Sleep(30);
        }

        var horizontal = direction is ScrollDirection.Left or ScrollDirection.Right;
        var sign = direction is ScrollDirection.Up or ScrollDirection.Right ? 1 : -1;
        for (var i = 0; i < amount; i++)
        {
            Send(Mouse(horizontal ? Win32.MouseEventFHWheel : Win32.MouseEventFWheel, unchecked((uint)(sign * WheelDelta))));
            Thread.Sleep(20);
        }
    }

    /// <summary>Alt down and up: counts as user input, so Windows lets this process change the foreground window.</summary>
    public static void TapAlt() => Send(Key(VkMenu, false), Key(VkMenu, true));

    private static void Tap(ushort vk) => Send(Key(vk, false), Key(vk, true));

    private static Win32.Input Key(ushort vk, bool up) => new()
    {
        Type = Win32.InputKeyboard,
        U = new Win32.InputUnion
        {
            Ki = new Win32.KeybdInput
            {
                WVk = vk,
                WScan = (ushort)Win32.MapVirtualKey(vk, 0),
                DwFlags = (up ? Win32.KeyEventFKeyUp : 0) | (KeyCombo.IsExtended(vk) ? Win32.KeyEventFExtendedKey : 0),
            },
        },
    };

    private static Win32.Input Unicode(char c, bool up) => new()
    {
        Type = Win32.InputKeyboard,
        U = new Win32.InputUnion
        {
            Ki = new Win32.KeybdInput { WVk = 0, WScan = c, DwFlags = Win32.KeyEventFUnicode | (up ? Win32.KeyEventFKeyUp : 0) },
        },
    };

    private static Win32.Input Mouse(uint flags, uint data) => new()
    {
        Type = Win32.InputMouse,
        U = new Win32.InputUnion { Mi = new Win32.MouseInput { DwFlags = flags, MouseData = data } },
    };

    private static void Send(params Win32.Input[] inputs)
    {
        if (Win32.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<Win32.Input>()) != inputs.Length)
        {
            // Blocked by UIPI (a window of an elevated program is in front) or the secure desktop.
            throw CommandException.Unavailable(
                "Windows didn't accept the input: the window in front may belong to a program running as administrator.");
        }
    }
}
