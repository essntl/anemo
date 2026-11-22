using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using System.Windows.Automation;
using Anemo.Desktop.Core.Platform;

namespace Anemo.Desktop.Platform;

/// <summary>
/// Reads a window's UI Automation tree (the control view), with the properties fetched in
/// one call per element. The walk stops at 3000 elements, 40 levels or 5 seconds, so a
/// huge page can't hang a look; the tree is then marked truncated.
/// </summary>
internal static class UiaTree
{
    private const int MaxNodes = 3000;
    private const int MaxDepth = 40;
    private const int MaxDocumentText = 10_000;
    private static readonly TimeSpan MaxTime = TimeSpan.FromSeconds(5);

    private static readonly HashSet<ControlType> InteractiveTypes =
    [
        ControlType.Button, ControlType.CheckBox, ControlType.ComboBox, ControlType.Edit, ControlType.Hyperlink,
        ControlType.ListItem, ControlType.MenuItem, ControlType.RadioButton, ControlType.Slider, ControlType.Spinner,
        ControlType.SplitButton, ControlType.TabItem, ControlType.TreeItem, ControlType.Document, ControlType.DataItem,
        ControlType.MenuBar, ControlType.Menu,
    ];

    public static UiTree Read(IntPtr hwnd, CancellationToken ct)
    {
        AutomationElement root;
        var cache = Request();
        using (cache.Activate())
        {
            try
            {
                root = AutomationElement.FromHandle(hwnd);
            }
            catch (Exception e) when (IsGone(e) || e is ArgumentException)
            {
                return new UiTree([], false);
            }
        }

        var nodes = new List<UiNode>();
        var watch = Stopwatch.StartNew();
        var truncated = false;
        var walker = TreeWalker.ControlViewWalker;

        void Walk(AutomationElement element, int depth)
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
            if (Node(element, depth) is { } node)
            {
                nodes.Add(node);
            }

            AutomationElement? child;
            try
            {
                child = walker.GetFirstChild(element, cache);
            }
            catch (Exception e) when (IsGone(e))
            {
                return;
            }

            while (child is not null && !truncated)
            {
                Walk(child, depth + 1);
                try
                {
                    child = walker.GetNextSibling(child, cache);
                }
                catch (Exception e) when (IsGone(e))
                {
                    break;
                }
            }
        }

        Walk(root, 0);
        return new UiTree(nodes, truncated);
    }

    /// <summary>The properties every node is read with, in one round trip.</summary>
    private static CacheRequest Request()
    {
        var cache = new CacheRequest { TreeScope = TreeScope.Element, TreeFilter = Automation.ControlViewCondition };
        cache.Add(AutomationElement.ControlTypeProperty);
        cache.Add(AutomationElement.NameProperty);
        cache.Add(AutomationElement.IsEnabledProperty);
        cache.Add(AutomationElement.IsPasswordProperty);
        cache.Add(AutomationElement.IsOffscreenProperty);
        cache.Add(AutomationElement.IsInvokePatternAvailableProperty);
        cache.Add(AutomationElement.IsTextPatternAvailableProperty);
        cache.Add(ValuePattern.ValueProperty);
        return cache;
    }

    private static UiNode? Node(AutomationElement element, int depth)
    {
        try
        {
            var type = (ControlType)element.GetCachedPropertyValue(AutomationElement.ControlTypeProperty);
            var name = element.GetCachedPropertyValue(AutomationElement.NameProperty) as string;
            var enabled = element.GetCachedPropertyValue(AutomationElement.IsEnabledProperty) is true;
            var password = element.GetCachedPropertyValue(AutomationElement.IsPasswordProperty) is true;
            var offscreen = element.GetCachedPropertyValue(AutomationElement.IsOffscreenProperty) is true;
            var invokable = element.GetCachedPropertyValue(AutomationElement.IsInvokePatternAvailableProperty) is true;
            var value = password ? null : element.GetCachedPropertyValue(ValuePattern.ValueProperty, true) as string;
            if (value is null && !password && type == ControlType.Document
                && element.GetCachedPropertyValue(AutomationElement.IsTextPatternAvailableProperty) is true)
            {
                value = DocumentText(element);
            }

            var interactive = !offscreen && (InteractiveTypes.Contains(type) || invokable);
            return new UiNode(depth, Role(type), name, value, enabled, password, interactive, new UiaElement(element));
        }
        catch (Exception e) when (IsGone(e))
        {
            return null;
        }
    }

    private static string? DocumentText(AutomationElement element)
    {
        try
        {
            return ((TextPattern)element.GetCurrentPattern(TextPattern.Pattern)).DocumentRange.GetText(MaxDocumentText);
        }
        catch (Exception e) when (IsGone(e))
        {
            return null;
        }
    }

    /// <summary>
    /// What UI Automation throws when an element vanished or its program stopped
    /// answering: treated as "not there", never as a crash.
    /// </summary>
    public static bool IsGone(Exception e) =>
        e is ElementNotAvailableException or System.Runtime.InteropServices.COMException
            or InvalidOperationException or TimeoutException or InvalidCastException;

    /// <summary><c>ControlType.Button</c> → <c>button</c>; the same in every Windows language.</summary>
    public static string Role(ControlType type)
    {
        var name = type.ProgrammaticName;
        var dot = name.LastIndexOf('.');
        return (dot >= 0 ? name[(dot + 1)..] : name).ToLowerInvariant();
    }
}
