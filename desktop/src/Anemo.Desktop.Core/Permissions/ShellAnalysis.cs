using System.Text.Json.Nodes;

namespace Anemo.Desktop.Core.Permissions;

/// <summary>One thing a command does to a path (spec 25 §5.2).</summary>
public sealed record ShellEffect(EffectKind Kind, string Path, bool Recursive, string? WorkFolder, bool Recycle);

/// <summary>
/// What the analyser made of a command (§5.2): the verdict, the effects, what it couldn't tell,
/// the one sentence that decided (<see cref="Rule"/>) and whether it uses the network.
/// </summary>
public sealed record ShellAnalysis(
    Verdict Verdict,
    IReadOnlyList<ShellEffect> Effects,
    IReadOnlyList<string> Unknown,
    string Rule,
    bool Network,
    int ProfileVersion)
{
    /// <summary>The command could not be read with certainty: only Once or "this exact command" covers it (§6.2).</summary>
    public bool Opaque => Unknown.Count > 0;

    /// <summary>Every delete is in a work folder whose deletes go to the Recycle Bin (§8).</summary>
    public bool RecycleDeletes =>
        Effects.Any(e => e.Kind == EffectKind.Delete) && Effects.Where(e => e.Kind == EffectKind.Delete).All(e => e.Recycle);

    public static string Name(Verdict v) => v switch { Verdict.Allow => "allow", Verdict.Ask => "ask", _ => "deny" };

    public static string Name(EffectKind k) => k.ToString().ToLowerInvariant();

    public JsonObject ToJson() => new()
    {
        ["verdict"] = Name(Verdict),
        ["effects"] = new JsonArray(Effects.Take(50).Select(e => (JsonNode)new JsonObject
        {
            ["kind"] = Name(e.Kind),
            ["path"] = e.Path,
            ["recursive"] = e.Recursive,
            ["work_folder"] = e.WorkFolder,
            ["recycle"] = e.Recycle,
        }).ToArray()),
        ["unknown"] = new JsonArray(Unknown.Take(20).Select(u => (JsonNode)JsonValue.Create(u)!).ToArray()),
        ["rule"] = Rule,
        ["network"] = Network,
        ["profile_version"] = ProfileVersion,
    };
}
