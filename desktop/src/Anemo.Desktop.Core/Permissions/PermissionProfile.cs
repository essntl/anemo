using System.Text.Json;
using System.Text.Json.Nodes;
using Anemo.Desktop.Core.Protocol;

namespace Anemo.Desktop.Core.Permissions;

/// <summary>A work folder of the device's profile (spec 25 §4.1).</summary>
public sealed record WorkFolder(string Path, bool Recycle, string AddedFrom);

/// <summary>
/// The device's copy of its permission profile, as <c>profile.sync</c> sends it
/// (device-contracts.md §9): the profile's category levels, the device's work folders and
/// protected-folder levels, and the version the server bumps on every change. Anemo Desktop
/// enforces this copy on every <c>shell</c> (§6.1).
/// </summary>
public sealed record PermissionProfile(
    int Version,
    string Name,
    string? Preset,
    IReadOnlyDictionary<string, string> Categories,
    IReadOnlyList<WorkFolder> WorkFolders,
    IReadOnlyDictionary<string, string> Protected,
    bool RelevanceCheck,
    bool AutomationsUnrestricted)
{
    public static readonly string[] CategoryNames = ["see", "act", "shell", "files", "code"];

    /// <summary>
    /// What a device that has never had a profile (an older server) does: as before profiles,
    /// the server decides; only the hard floor holds (spec 25 §4.3).
    /// </summary>
    public static PermissionProfile Legacy { get; } = new(
        0, "Trusted (legacy)", "legacy",
        CategoryNames.ToDictionary(c => c, _ => "policy"),
        [],
        new Dictionary<string, string>(),
        false,
        false);

    /// <summary>The level of a category: allow, ask, deny, folders or policy.</summary>
    public string Level(string category) => Categories.TryGetValue(category, out var level) ? level : "deny";

    /// <summary>The profile from <c>profile.sync</c>'s <c>profile</c>, or null when it is malformed.</summary>
    public static PermissionProfile? FromJson(JsonNode? node)
    {
        if (node is not JsonObject o || Wire.Number(o["version"]) is not double version || o["categories"] is not JsonObject cats)
        {
            return null;
        }

        var categories = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var name in CategoryNames)
        {
            categories[name] = Wire.Str(cats, name) is { } level && level is "allow" or "ask" or "deny" or "folders" or "policy" ? level : "deny";
        }

        var folders = new List<WorkFolder>();
        if (o["work_folders"] is JsonArray list)
        {
            foreach (var item in list.OfType<JsonObject>())
            {
                if (Wire.Str(item, "path") is { Length: > 1 } path)
                {
                    folders.Add(new WorkFolder(path, item["recycle"] is JsonValue r && r.TryGetValue<bool>(out var b) && b, Wire.Str(item, "added_from") ?? "settings"));
                }
            }
        }

        var protectedLevels = new Dictionary<string, string>(StringComparer.Ordinal);
        if (o["protected"] is JsonObject prot)
        {
            foreach (var (key, value) in prot)
            {
                if (value is JsonValue v && v.TryGetValue<string>(out var level) && level is "deny" or "ask" or "hard")
                {
                    protectedLevels[key] = level;
                }
            }
        }

        var profile = o["profile"] as JsonObject;
        return new PermissionProfile(
            (int)version,
            profile is null ? "" : Wire.Str(profile, "name") ?? "",
            profile is null ? null : Wire.Str(profile, "preset"),
            categories,
            folders,
            protectedLevels,
            Bool(o, "relevance_check"),
            Bool(o, "automations_unrestricted"));
    }

    public JsonObject ToJson() => new()
    {
        ["version"] = Version,
        ["profile"] = new JsonObject { ["name"] = Name, ["preset"] = Preset },
        ["categories"] = new JsonObject(Categories.Select(kv => KeyValuePair.Create(kv.Key, (JsonNode?)kv.Value))),
        ["work_folders"] = new JsonArray(WorkFolders.Select(f => (JsonNode)new JsonObject
        {
            ["path"] = f.Path,
            ["recycle"] = f.Recycle,
            ["added_from"] = f.AddedFrom,
        }).ToArray()),
        ["protected"] = new JsonObject(Protected.Select(kv => KeyValuePair.Create(kv.Key, (JsonNode?)kv.Value))),
        ["relevance_check"] = RelevanceCheck,
        ["automations_unrestricted"] = AutomationsUnrestricted,
    };

    private static readonly Dictionary<string, int> Rank = new(StringComparer.Ordinal)
    {
        ["allow"] = 0, ["policy"] = 1, ["folders"] = 1, ["ask"] = 2, ["deny"] = 3,
    };

    /// <summary>
    /// Whether <paramref name="next"/> loosens anything compared with this one (spec 25 §10): a
    /// looser category, a new work folder, a protected folder switched from deny to ask, the
    /// relevance check off, or "Unrestricted for automations" on. Only these wait for the
    /// on-site confirmation; tightening applies at once.
    /// </summary>
    public bool LoosenedBy(PermissionProfile next)
    {
        foreach (var name in CategoryNames)
        {
            if (Rank.GetValueOrDefault(next.Level(name), 3) < Rank.GetValueOrDefault(Level(name), 3))
            {
                return true;
            }
        }

        var known = WorkFolders.Select(f => f.Path).ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (next.WorkFolders.Any(f => !known.Contains(f.Path)))
        {
            return true;
        }

        if (next.Protected.Any(kv => kv.Value == "ask" && Protected.TryGetValue(kv.Key, out var old) && old == "deny"))
        {
            return true;
        }

        return (RelevanceCheck && !next.RelevanceCheck) || (next.AutomationsUnrestricted && !AutomationsUnrestricted);
    }

    /// <summary>What a person reads in the confirmation: the first thing that loosens.</summary>
    public string DescribeLoosening(PermissionProfile next)
    {
        var known = WorkFolders.Select(f => f.Path).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var folder = next.WorkFolders.FirstOrDefault(f => !known.Contains(f.Path));
        if (folder is not null)
        {
            return $"Anemo wants to make {folder.Path} a work folder. Allow?";
        }

        if (next.Name != Name)
        {
            return $"Anemo wants to switch this computer to the profile “{next.Name}”. Allow?";
        }

        return "Anemo wants to loosen what agents may do on this computer. Allow?";
    }

    private static bool Bool(JsonObject o, string key) => o[key] is JsonValue v && v.TryGetValue<bool>(out var b) && b;
}

/// <summary>
/// <c>permissions.json</c> in Anemo Desktop's data folder (the hard floor: no agent can write it,
/// §4.3): the profile in force, and one that waits for the on-site confirmation.
/// </summary>
public sealed class PermissionStore
{
    private readonly string _path;
    private readonly object _lock = new();

    public PermissionStore(string path)
    {
        _path = path;
        (Applied, Pending) = Load(path);
    }

    /// <summary>The profile enforced now; null when the server never sent one (an older server).</summary>
    public PermissionProfile? Applied { get; private set; }

    /// <summary>A loosening that waits for a click on this computer.</summary>
    public PermissionProfile? Pending { get; private set; }

    public void Apply(PermissionProfile profile)
    {
        lock (_lock)
        {
            Applied = profile;
            Pending = null;
            Save();
        }
    }

    public void Hold(PermissionProfile profile)
    {
        lock (_lock)
        {
            Pending = profile;
            Save();
        }
    }

    /// <summary>The user allowed the pending profile; false when there is none.</summary>
    public bool ConfirmPending()
    {
        lock (_lock)
        {
            if (Pending is null)
            {
                return false;
            }

            Applied = Pending;
            Pending = null;
            Save();
            return true;
        }
    }

    public void RejectPending()
    {
        lock (_lock)
        {
            Pending = null;
            Save();
        }
    }

    private void Save()
    {
        var doc = new JsonObject { ["applied"] = Applied?.ToJson(), ["pending"] = Pending?.ToJson() };
        var folder = Path.GetDirectoryName(_path);
        if (!string.IsNullOrEmpty(folder))
        {
            Directory.CreateDirectory(folder);
        }

        var temp = _path + ".tmp";
        File.WriteAllText(temp, doc.ToJsonString());
        File.Move(temp, _path, overwrite: true);
    }

    private static (PermissionProfile?, PermissionProfile?) Load(string path)
    {
        try
        {
            if (!File.Exists(path) || JsonNode.Parse(File.ReadAllText(path)) is not JsonObject doc)
            {
                return (null, null);
            }

            return (PermissionProfile.FromJson(doc["applied"]), PermissionProfile.FromJson(doc["pending"]));
        }
        catch (Exception e) when (e is IOException or JsonException or UnauthorizedAccessException)
        {
            // An unreadable copy: the strictest safe start is Watched-like until the server syncs.
            return (WatchedUntilSynced, null);
        }
    }

    /// <summary>What applies when the stored copy can't be read: nothing on the shell until the next sync.</summary>
    public static PermissionProfile WatchedUntilSynced { get; } = PermissionProfile.Legacy with
    {
        Name = "Watched",
        Preset = "watched",
        Categories = PermissionProfile.CategoryNames.ToDictionary(c => c, c => c == "see" ? "policy" : c == "act" ? "ask" : "deny"),
    };
}
