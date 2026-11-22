using System;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Automation;
using Anemo.Desktop.Core.Platform;

namespace Anemo.Desktop.Platform;

/// <summary>A control from UI Automation; a vanished control throws <see cref="ElementGoneException"/>.</summary>
internal sealed class UiaElement : IUiElement
{
    /// <summary>
    /// Invoke can block until a dialog it opened is closed (Win32 buttons); after this the
    /// click counts as done.
    /// </summary>
    private static readonly TimeSpan InvokeWait = TimeSpan.FromSeconds(3);

    private readonly AutomationElement _element;

    public UiaElement(AutomationElement element) => _element = element;

    public bool IsPassword => Live(() => _element.Current.IsPassword);

    public bool IsEnabled => Live(() => _element.Current.IsEnabled);

    public bool TryInvoke() => Live(() =>
    {
        if (_element.TryGetCurrentPattern(InvokePattern.Pattern, out var invoke))
        {
            var task = Task.Run(() => ((InvokePattern)invoke).Invoke());
            if (task.Wait(InvokeWait))
            {
                task.GetAwaiter().GetResult();
            }

            return true;
        }

        if (_element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out var expand))
        {
            var pattern = (ExpandCollapsePattern)expand;
            if (pattern.Current.ExpandCollapseState == ExpandCollapseState.Expanded)
            {
                pattern.Collapse();
            }
            else
            {
                pattern.Expand();
            }

            return true;
        }

        return false;
    });

    public bool TrySetValue(string text) => Live(() =>
    {
        // Checked again here: a control can become a password field after the look.
        if (_element.Current.IsPassword || !_element.TryGetCurrentPattern(ValuePattern.Pattern, out var value))
        {
            return false;
        }

        var pattern = (ValuePattern)value;
        if (pattern.Current.IsReadOnly)
        {
            return false;
        }

        pattern.SetValue(text);
        return true;
    });

    public bool TryScroll(ScrollDirection direction, int amount) => Live(() =>
    {
        if (!_element.TryGetCurrentPattern(ScrollPattern.Pattern, out var scroll))
        {
            return false;
        }

        var pattern = (ScrollPattern)scroll;
        var vertical = direction is ScrollDirection.Up or ScrollDirection.Down;
        if (vertical ? !pattern.Current.VerticallyScrollable : !pattern.Current.HorizontallyScrollable)
        {
            return false;
        }

        var step = direction is ScrollDirection.Up or ScrollDirection.Left ? ScrollAmount.SmallDecrement : ScrollAmount.SmallIncrement;
        for (var i = 0; i < amount; i++)
        {
            if (vertical)
            {
                pattern.ScrollVertical(step);
            }
            else
            {
                pattern.ScrollHorizontal(step);
            }
        }

        return true;
    });

    public ScreenPoint PrepareForMouse() => Live(() =>
    {
        var window = TopLevelWindow();
        if (window != IntPtr.Zero && Win32.GetAncestor(Win32.GetForegroundWindow(), Win32.GaRoot) != window)
        {
            Windows.Focus(window);
        }

        if (_element.Current.IsOffscreen && _element.TryGetCurrentPattern(ScrollItemPattern.Pattern, out var item))
        {
            ((ScrollItemPattern)item).ScrollIntoView();
        }

        if (_element.TryGetClickablePoint(out var point))
        {
            return new ScreenPoint((int)point.X, (int)point.Y);
        }

        var r = _element.Current.BoundingRectangle;
        if (r.IsEmpty)
        {
            throw new ElementGoneException();
        }

        return new ScreenPoint((int)(r.X + r.Width / 2), (int)(r.Y + r.Height / 2));
    });

    public void Focus() => Live(() =>
    {
        _element.SetFocus();
        return true;
    });

    private IntPtr TopLevelWindow()
    {
        var walker = TreeWalker.RawViewWalker;
        var current = _element;
        while (true)
        {
            var parent = walker.GetParent(current);
            if (parent is null || parent == AutomationElement.RootElement)
            {
                var handle = new IntPtr(current.Current.NativeWindowHandle);
                return handle == IntPtr.Zero ? IntPtr.Zero : Win32.GetAncestor(handle, Win32.GaRoot);
            }

            current = parent;
        }
    }

    private static T Live<T>(Func<T> action)
    {
        try
        {
            return action();
        }
        catch (ElementNotAvailableException e)
        {
            throw new ElementGoneException(e);
        }
        catch (COMException e)
        {
            throw new ElementGoneException(e);
        }
    }
}
