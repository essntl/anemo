using System;
using System.Collections.Generic;
using System.Windows.Forms;
using Anemo.Desktop.Core.Control;
using Anemo.Desktop.Platform;

namespace Anemo.Desktop.UI;

/// <summary>
/// The global hotkeys (stop, share). WM_HOTKEY arrives on the UI thread, which never runs
/// commands, so the stop key works while the agent is typing.
/// </summary>
internal sealed class HotkeyWindow : NativeWindow, IDisposable
{
    private readonly Dictionary<int, Action> _actions = [];
    private int _nextId = 1;

    public HotkeyWindow() => CreateHandle(new CreateParams());

    /// <summary>Registers the key; false when another program has it already.</summary>
    public bool Register(Hotkey key, Action action)
    {
        var id = _nextId++;
        if (!Win32.RegisterHotKey(Handle, id, (uint)key.Modifiers | Win32.ModNoRepeat, key.Key))
        {
            return false;
        }

        _actions[id] = action;
        return true;
    }

    public void UnregisterAll()
    {
        foreach (var id in _actions.Keys)
        {
            Win32.UnregisterHotKey(Handle, id);
        }

        _actions.Clear();
    }

    public void Dispose()
    {
        UnregisterAll();
        DestroyHandle();
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == Win32.WmHotkey && _actions.TryGetValue(m.WParam.ToInt32(), out var action))
        {
            action();
            return;
        }

        base.WndProc(ref m);
    }
}
