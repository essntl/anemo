using System.Text;
using System.Text.Json.Nodes;
using Anemo.Desktop.Core.Platform;

namespace Anemo.Desktop.Core.Commands;

/// <summary>A window's controls and text as the agent sees them, with the refs they got.</summary>
internal sealed record WindowText(
    JsonArray Controls,
    string Text,
    bool Truncated,
    IReadOnlyDictionary<string, IUiElement> Refs);

/// <summary>
/// Turns a UI Automation tree into the <c>controls</c> and <c>text</c> of a state
/// (device-contracts.md §3): interactive controls numbered <c>c1</c>, <c>c2</c> … (at most
/// 300), and the window as indented lines (at most 40 000 characters). A password
/// control's value is never given.
/// </summary>
internal static class StateBuilder
{
    public const int MaxControls = 300;
    public const int MaxText = 40_000;
    private const int MaxName = 300;
    private const int MaxValue = 1_000;
    private const int MaxValueInText = 10_000;
    private const int MaxIndent = 12;

    public static WindowText Describe(UiTree tree)
    {
        var controls = new JsonArray();
        var refs = new Dictionary<string, IUiElement>(StringComparer.Ordinal);
        var text = new StringBuilder();
        var truncated = tree.Truncated;

        foreach (var node in tree.Nodes)
        {
            var name = Cut(Clean(node.Name), MaxName);
            var value = node.Password ? null : Clean(node.Value);
            string? reference = null;

            if (node.Interactive && node.Element is not null)
            {
                if (refs.Count < MaxControls)
                {
                    reference = $"c{refs.Count + 1}";
                    refs[reference] = node.Element;
                    controls.Add(new JsonObject
                    {
                        ["ref"] = reference,
                        ["role"] = node.Role,
                        ["name"] = name,
                        ["value"] = Cut(value, MaxValue),
                        ["enabled"] = node.Enabled,
                        ["password"] = node.Password,
                    });
                }
                else
                {
                    truncated = true;
                }
            }
            else if (string.IsNullOrEmpty(name) && string.IsNullOrEmpty(value))
            {
                continue; // a pane or group without text adds nothing to read
            }

            var line = Line(node, reference, name, Cut(value, MaxValueInText));
            if (text.Length + line.Length + 1 > MaxText)
            {
                truncated = true;
                break;
            }

            text.Append(line).Append('\n');
        }

        return new WindowText(controls, text.ToString().TrimEnd('\n'), truncated, refs);
    }

    private static string Line(UiNode node, string? reference, string? name, string? value)
    {
        var line = new StringBuilder();
        line.Append(' ', Math.Min(node.Depth, MaxIndent) * 2);
        if (reference is not null)
        {
            line.Append('[').Append(reference).Append("] ");
        }

        line.Append(node.Role);
        if (!string.IsNullOrEmpty(name))
        {
            line.Append(" \"").Append(name).Append('"');
        }

        if (node.Password)
        {
            line.Append(" (password)");
        }
        else if (!string.IsNullOrEmpty(value) && value != name)
        {
            line.Append(": ").Append(value);
        }

        if (!node.Enabled && reference is not null)
        {
            line.Append(" (disabled)");
        }

        return line.ToString();
    }

    private static string? Clean(string? s) =>
        string.IsNullOrWhiteSpace(s) ? null : s.Replace("\r\n", "\n").Trim();

    private static string? Cut(string? s, int max) =>
        s is null || s.Length <= max ? s : s[..max] + "…";
}
