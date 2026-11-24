using Anemo.Desktop.Core.Control;
using Anemo.Desktop.Core.Platform;
using Anemo.Desktop.Mac.Native;

namespace Anemo.Desktop.Mac.Platform;

/// <summary>
/// The stop and share keys as system-wide hot keys (Carbon; no permission needed). Settings
/// writes them as on Windows: Ctrl+Alt+Shift+S, where Alt is Option and Win is Cmd.
/// </summary>
internal sealed class HotKeys : IDisposable
{
    private readonly List<nint> _registered = [];
    private uint _nextId = 1;

    /// <summary>False when another app holds the combination (or the key has no Mac key code).</summary>
    public bool Register(Hotkey hotkey, Action pressed)
    {
        if (MacKeyCodes.KeyCode((ushort)hotkey.Key) is not { } keyCode)
        {
            return false;
        }

        uint modifiers = 0;
        if (hotkey.Modifiers.HasFlag(HotkeyModifiers.Control))
        {
            modifiers |= Carbon.ControlKey;
        }

        if (hotkey.Modifiers.HasFlag(HotkeyModifiers.Alt))
        {
            modifiers |= Carbon.OptionKey;
        }

        if (hotkey.Modifiers.HasFlag(HotkeyModifiers.Shift))
        {
            modifiers |= Carbon.ShiftKey;
        }

        if (hotkey.Modifiers.HasFlag(HotkeyModifiers.Win))
        {
            modifiers |= Carbon.CmdKey;
        }

        var handle = Carbon.Register(_nextId++, keyCode, modifiers, pressed);
        if (handle == 0)
        {
            return false;
        }

        _registered.Add(handle);
        return true;
    }

    public void UnregisterAll()
    {
        foreach (var handle in _registered)
        {
            Carbon.Unregister(handle);
        }

        _registered.Clear();
    }

    public void Dispose() => UnregisterAll();
}
