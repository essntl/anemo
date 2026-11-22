using Anemo.Desktop.Core.Platform;

namespace Anemo.Desktop.Core.Commands;

/// <summary>
/// Control refs (<c>c12</c>) of the last state. They are valid for the next command only
/// (device-contracts.md §3): every command takes the table and leaves an empty one or the
/// table of its own new state.
/// </summary>
internal sealed class ControlRefs
{
    public const string StaleMessage = "That control is gone; look again";

    private Dictionary<string, IUiElement> _current = new(StringComparer.Ordinal);

    /// <summary>The refs of the previous state; the table is empty afterwards.</summary>
    public IReadOnlyDictionary<string, IUiElement> Take()
    {
        var taken = _current;
        _current = new Dictionary<string, IUiElement>(StringComparer.Ordinal);
        return taken;
    }

    public void Replace(IReadOnlyDictionary<string, IUiElement> refs) =>
        _current = new Dictionary<string, IUiElement>(refs, StringComparer.Ordinal);

    public static IUiElement Resolve(IReadOnlyDictionary<string, IUiElement> refs, string reference) =>
        refs.TryGetValue(reference, out var element) ? element : throw CommandException.Failed(StaleMessage);
}

/// <summary>
/// Window refs (<c>w3</c>). Unlike control refs they last as long as their window, so a
/// <c>windows</c> list can be followed by <c>focus_window</c> or a look at one window.
/// </summary>
internal sealed class WindowRefs
{
    public const string GoneMessage = "That window is gone; look again";

    private readonly Dictionary<long, int> _byHandle = new();
    private readonly Dictionary<int, long> _byNumber = new();
    private int _next = 1;

    public string RefFor(long handle)
    {
        if (!_byHandle.TryGetValue(handle, out var n))
        {
            n = _next++;
            _byHandle[handle] = n;
            _byNumber[n] = handle;
        }

        return $"w{n}";
    }

    /// <summary>The window's handle, or a failure when the ref is unknown or the window closed.</summary>
    public WindowInfo Resolve(IDesktop desktop, string reference)
    {
        if (reference.Length < 2 || reference[0] != 'w' || !int.TryParse(reference[1..], out var n)
            || !_byNumber.TryGetValue(n, out var handle))
        {
            throw CommandException.Failed(GoneMessage);
        }

        var window = desktop.FindWindow(handle);
        if (window is null)
        {
            _byNumber.Remove(n);
            _byHandle.Remove(handle);
            throw CommandException.Failed(GoneMessage);
        }

        return window;
    }
}
