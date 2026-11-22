using System.Text.Json.Nodes;
using Anemo.Desktop.Core.Platform;

namespace Anemo.Desktop.Core.Commands;

public sealed partial class CommandProcessor
{
    private JsonNode Look(Args args, CancellationToken ct)
    {
        var what = args.OptionalString("what") ?? "window";
        switch (what)
        {
            case "windows":
                return ListWindows();
            case "screen":
                _lastMode = "screen";
                return ScreenState(ct);
            case "window":
                var reference = args.OptionalString("window_ref");
                var window = reference is null ? Desktop.FrontWindow() : _windows.Resolve(Desktop, reference);
                if (window is null)
                {
                    throw CommandException.Failed("There is no window in front; look at the screen or the list of windows.");
                }

                if (window.Minimized)
                {
                    throw CommandException.Failed("That window is minimized; bring it up with focus_window first.");
                }

                _lastMode = "window";
                return WindowState(window, ct);
            default:
                throw CommandException.Failed($"“what” must be screen, window or windows, not “{what}”.");
        }
    }

    private JsonNode ListWindows()
    {
        var list = new JsonArray();
        foreach (var w in Desktop.ListWindows())
        {
            list.Add(new JsonObject
            {
                ["ref"] = _windows.RefFor(w.Handle),
                ["title"] = w.Title,
                ["app"] = w.App,
                ["minimized"] = w.Minimized,
            });
        }

        return new JsonObject { ["windows"] = list };
    }

    /// <summary>After an action: the same kind of look as the last one, of the window now in front.</summary>
    private JsonNode StateAfterAction(CancellationToken ct)
    {
        var front = Desktop.FrontWindow();
        return _lastMode == "screen" || front is null || front.Minimized ? ScreenState(ct) : WindowState(front, ct);
    }

    private JsonNode ScreenState(CancellationToken ct)
    {
        var capture = Desktop.CaptureScreen();
        return State(Desktop.FrontWindow(), capture, ct);
    }

    private JsonNode WindowState(WindowInfo window, CancellationToken ct)
    {
        var capture = Desktop.CaptureWindow(window.Handle);
        return State(window, capture, ct);
    }

    private JsonObject State(WindowInfo? window, ScreenCapture capture, CancellationToken ct)
    {
        _lastCapture = capture;
        var described = window is null
            ? new WindowText(new JsonArray(), "", false, new Dictionary<string, IUiElement>())
            : StateBuilder.Describe(Desktop.ReadTree(window.Handle, ct));
        _refs.Replace(described.Refs);

        var state = new JsonObject
        {
            ["window"] = window is null
                ? null
                : new JsonObject
                {
                    ["ref"] = _windows.RefFor(window.Handle),
                    ["title"] = window.Title,
                    ["app"] = window.App,
                },
            ["screenshot"] = Convert.ToBase64String(capture.Png),
            ["scale"] = Math.Round(capture.Scale, 4),
            ["controls"] = described.Controls,
            ["text"] = described.Text,
            ["truncated"] = described.Truncated,
        };
        if (window is null)
        {
            state["note"] = "No window is in front.";
        }
        else if (described.Truncated)
        {
            state["note"] = $"The window has more than fits: only the first {StateBuilder.MaxControls} controls have refs.";
        }

        return state;
    }
}
