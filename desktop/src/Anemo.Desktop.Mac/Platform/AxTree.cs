using System.Diagnostics;
using Anemo.Desktop.Core.Platform;
using Anemo.Desktop.Mac.Native;

namespace Anemo.Desktop.Mac.Platform;

/// <summary>
/// A window's controls through the Accessibility API, as Core's <see cref="UiTree"/> (the
/// Windows client reads UI Automation the same way). Roles are given the Windows client's
/// names (button, edit, check box, …) so the agent reads both alike.
/// </summary>
internal static class AxTree
{
    private const int MaxNodes = 3000;
    private const int MaxDepth = 40;
    private static readonly TimeSpan MaxTime = TimeSpan.FromSeconds(5);

    private static readonly Dictionary<string, string> Roles = new(StringComparer.Ordinal)
    {
        ["AXButton"] = "button",
        ["AXMenuButton"] = "button",
        ["AXPopUpButton"] = "combo box",
        ["AXComboBox"] = "combo box",
        ["AXTextField"] = "edit",
        ["AXSecureTextField"] = "edit",
        ["AXTextArea"] = "edit",
        ["AXSearchField"] = "edit",
        ["AXCheckBox"] = "check box",
        ["AXRadioButton"] = "radio button",
        ["AXMenuItem"] = "menu item",
        ["AXMenuBarItem"] = "menu item",
        ["AXLink"] = "link",
        ["AXSlider"] = "slider",
        ["AXIncrementor"] = "spinner",
        ["AXDisclosureTriangle"] = "button",
        ["AXTabGroup"] = "tab",
        ["AXStaticText"] = "text",
        ["AXImage"] = "image",
        ["AXRow"] = "list item",
        ["AXCell"] = "data item",
        ["AXList"] = "list",
        ["AXTable"] = "table",
        ["AXOutline"] = "tree",
        ["AXScrollArea"] = "pane",
        ["AXGroup"] = "group",
        ["AXToolbar"] = "tool bar",
        ["AXWindow"] = "window",
        ["AXSheet"] = "window",
        ["AXWebArea"] = "document",
        ["AXHeading"] = "header",
        ["AXMenuBar"] = "menu bar",
        ["AXMenu"] = "menu",
    };

    private static readonly HashSet<string> Interactive = new(StringComparer.Ordinal)
    {
        "AXButton", "AXMenuButton", "AXPopUpButton", "AXComboBox", "AXTextField", "AXSecureTextField",
        "AXTextArea", "AXSearchField", "AXCheckBox", "AXRadioButton", "AXMenuItem", "AXMenuBarItem",
        "AXLink", "AXSlider", "AXIncrementor", "AXDisclosureTriangle", "AXRow", "AXCell",
    };

    /// <summary>The tree of a window (its AXUIElement, retained by the caller).</summary>
    public static UiTree Read(nint window, CancellationToken ct)
    {
        var nodes = new List<UiNode>();
        var watch = Stopwatch.StartNew();
        var truncated = false;

        void Walk(nint element, int depth)
        {
            if (truncated)
            {
                return;
            }

            if (nodes.Count >= MaxNodes || watch.Elapsed > MaxTime || depth > MaxDepth)
            {
                truncated = true;
                return;
            }

            ct.ThrowIfCancellationRequested();
            nodes.Add(Node(element, depth));
            foreach (var child in AX.Elements(element, "AXChildren"))
            {
                try
                {
                    Walk(child, depth + 1);
                }
                finally
                {
                    CF.Release(child);
                }
            }
        }

        Walk(window, 0);
        return new UiTree(nodes, truncated);
    }

    /// <summary>A secure text field: by role or subrole (apps put it in either).</summary>
    public static bool IsPassword(nint element) =>
        AX.Text(element, "AXRole") == "AXSecureTextField" || AX.Text(element, "AXSubrole") == "AXSecureTextField";

    private static UiNode Node(nint element, int depth)
    {
        var role = AX.Text(element, "AXRole") ?? "AXUnknown";
        var password = IsPassword(element);
        var name = AX.Text(element, "AXTitle") is { Length: > 0 } title
            ? title
            : AX.Text(element, "AXDescription") is { Length: > 0 } description ? description : AX.Text(element, "AXPlaceholderValue");
        var value = password ? null : AX.ValueText(element);
        var enabled = AX.Bool(element, "AXEnabled") ?? true;
        var label = Roles.TryGetValue(role, out var known) ? known : role.StartsWith("AX", StringComparison.Ordinal) ? role[2..].ToLowerInvariant() : role;
        return new UiNode(depth, label, name, value, enabled, password, Interactive.Contains(role), new AxElement(CF.Retain(element)));
    }
}

/// <summary>
/// A control, by its AXUIElement (retained; freed by the finalizer, as refs are dropped at the
/// next command). Every member throws <see cref="ElementGoneException"/> when the control is gone.
/// </summary>
internal sealed class AxElement : IUiElement
{
    private readonly nint _element;

    public AxElement(nint element) => _element = element;

    ~AxElement() => CF.Release(_element);

    public nint Handle => _element;

    public bool IsPassword => Alive(() => AxTree.IsPassword(_element));

    public bool IsEnabled => Alive(() => AX.Bool(_element, "AXEnabled") ?? true);

    public bool TryInvoke()
    {
        var actions = Alive(() => AX.Actions(_element));
        foreach (var action in new[] { "AXPress", "AXConfirm", "AXPick", "AXOpen" })
        {
            if (actions.Contains(action))
            {
                return Check(AX.Perform(_element, action));
            }
        }

        return false;
    }

    public bool TrySetValue(string text)
    {
        if (!Alive(() => AX.Settable(_element, "AXValue")))
        {
            return false;
        }

        return Check(AX.SetText(_element, "AXValue", text));
    }

    public bool TryScroll(ScrollDirection direction, int amount)
    {
        // AXScrollArea has no "scroll by" action; the mouse wheel over it is used (PrepareForMouse).
        return false;
    }

    public ScreenPoint PrepareForMouse()
    {
        Raise();
        var frame = Alive(() => AX.Frame(_element)) ?? throw new ElementGoneException();
        return frame.ToScreenRect().Center;
    }

    public void Focus()
    {
        Raise();
        Check(AX.SetBool(_element, "AXFocused", true));
    }

    /// <summary>Brings the control's app and window to the front.</summary>
    private void Raise()
    {
        if (AX.GetPid(_element, out var pid) == AX.Success)
        {
            MacApps.Activate(pid);
        }

        var window = AX.Element(_element, "AXWindow");
        if (window != 0)
        {
            AX.Perform(window, "AXRaise");
            CF.Release(window);
        }
    }

    private static bool Check(int error) => error switch
    {
        AX.Success => true,
        AX.InvalidElement => throw new ElementGoneException(),
        _ => false,
    };

    private T Alive<T>(Func<T> read)
    {
        // A gone element answers kAXErrorInvalidUIElement to everything: AXRole tells.
        if (AX.Copy(_element, "AXRole", out var role) == AX.InvalidElement)
        {
            throw new ElementGoneException();
        }

        CF.Release(role);
        return read();
    }
}
