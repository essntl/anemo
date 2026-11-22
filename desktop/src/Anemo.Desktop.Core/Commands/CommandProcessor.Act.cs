using Anemo.Desktop.Core.Platform;

namespace Anemo.Desktop.Core.Commands;

public sealed partial class CommandProcessor
{
    private Task ActAsync(string action, Args args, IReadOnlyDictionary<string, IUiElement> refs, CancellationToken ct)
    {
        switch (action)
        {
            case "click":
                Click(args, refs, MouseButton.Left, 1);
                break;
            case "double_click":
                Click(args, refs, MouseButton.Left, 2);
                break;
            case "right_click":
                Click(args, refs, MouseButton.Right, 1);
                break;
            case "type":
                Type(args, refs, ct);
                break;
            case "press":
                Press(args, ct);
                break;
            case "scroll":
                Scroll(args, refs);
                break;
            case "focus_window":
                Desktop.FocusWindow(_windows.Resolve(Desktop, args.String("window_ref", 20)).Handle);
                break;
            case "open":
                Open(args.String("target", 2000));
                break;
        }

        return Task.CompletedTask;
    }

    private void Click(Args args, IReadOnlyDictionary<string, IUiElement> refs, MouseButton button, int count)
    {
        if (args.OptionalString("ref") is { } reference)
        {
            var element = ControlRefs.Resolve(refs, reference);
            if (!element.IsEnabled)
            {
                throw CommandException.Failed("That control is disabled.");
            }

            // UI Automation first: it doesn't depend on where the window is.
            if (button == MouseButton.Left && count == 1 && element.TryInvoke())
            {
                return;
            }

            _platform.Input.Click(element.PrepareForMouse(), button, count);
            return;
        }

        _platform.Input.Click(PointFromArgs(args), button, count);
    }

    /// <summary>x, y in the pixels of the last screenshot, back to screen pixels.</summary>
    private ScreenPoint PointFromArgs(Args args)
    {
        var x = args.OptionalNumber("x");
        var y = args.OptionalNumber("y");
        if (x is null || y is null)
        {
            throw CommandException.Failed("Give a control's ref, or x and y.");
        }

        var capture = _lastCapture ?? WholeScreenGeometry();
        if (x < 0 || y < 0 || x > capture.Width || y > capture.Height)
        {
            throw CommandException.Failed(
                $"x and y must be inside the last screenshot ({capture.Width} × {capture.Height} pixels).");
        }

        return ScreenshotScaler.ToScreen(capture, x.Value, y.Value);
    }

    /// <summary>Without a screenshot yet: the geometry a look at the whole screen would have.</summary>
    private ScreenCapture WholeScreenGeometry()
    {
        var screen = Desktop.VirtualScreen();
        var (w, h, scale) = ScreenshotScaler.Fit(screen.Width, screen.Height);
        return new ScreenCapture([], w, h, scale, screen.X, screen.Y);
    }

    private void Type(Args args, IReadOnlyDictionary<string, IUiElement> refs, CancellationToken ct)
    {
        var text = args.String("text", 5000);
        if (args.OptionalString("ref") is { } reference)
        {
            var element = ControlRefs.Resolve(refs, reference);
            if (element.IsPassword)
            {
                throw CommandException.Refused(PasswordMessage);
            }

            if (!element.IsEnabled)
            {
                throw CommandException.Failed("That control is disabled.");
            }

            if (element.TrySetValue(text))
            {
                return;
            }

            element.Focus();
        }

        // Typing goes where the focus is: check that it isn't a password field.
        if (FocusIsPassword())
        {
            throw CommandException.Refused(PasswordMessage);
        }

        _platform.Input.TypeText(text, ct);
    }

    private bool FocusIsPassword()
    {
        try
        {
            return Desktop.FocusedElement()?.IsPassword ?? false;
        }
        catch (ElementGoneException)
        {
            return false;
        }
    }

    private void Press(Args args, CancellationToken ct)
    {
        // Every key is checked before any is pressed.
        var combos = args.StringList("keys", 1, 10).Select(KeyParser.Parse).ToList();
        foreach (var combo in combos)
        {
            ct.ThrowIfCancellationRequested();
            _platform.Input.Press(combo);
        }
    }

    private void Scroll(Args args, IReadOnlyDictionary<string, IUiElement> refs)
    {
        var direction = args.String("direction", 10) switch
        {
            "up" => ScrollDirection.Up,
            "down" => ScrollDirection.Down,
            "left" => ScrollDirection.Left,
            "right" => ScrollDirection.Right,
            var other => throw CommandException.Failed($"“direction” must be up, down, left or right, not “{other}”."),
        };
        var amount = args.Int("amount", 1, 10, fallback: 3);

        if (args.OptionalString("ref") is { } reference)
        {
            var element = ControlRefs.Resolve(refs, reference);
            if (!element.TryScroll(direction, amount))
            {
                _platform.Input.Scroll(element.PrepareForMouse(), direction, amount);
            }

            return;
        }

        _platform.Input.Scroll(Desktop.FrontWindow()?.Bounds.Center, direction, amount);
    }

    private void Open(string target)
    {
        var trimmed = target.Trim();
        if (trimmed.Contains("://", StringComparison.Ordinal))
        {
            if (!Uri.TryCreate(trimmed, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https"))
            {
                throw CommandException.Failed("Only http and https addresses can be opened.");
            }

            _platform.Apps.OpenUrl(uri);
            return;
        }

        _platform.Apps.Launch(AppMatcher.Find(_platform.Apps.ListApps(), trimmed));
    }
}
