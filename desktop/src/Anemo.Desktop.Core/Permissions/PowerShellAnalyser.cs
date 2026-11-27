using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anemo.Desktop.Core.Protocol;

namespace Anemo.Desktop.Core.Permissions;

/// <summary>
/// Reads a PowerShell command through PowerShell's own parser and says what it would do
/// (docs/specs/25-device-permission-profiles.md §5): which paths it reads, writes, deletes or
/// runs programs in, or that it can't tell. Then the profile decides (§5.3): the hard floor and
/// deny-protected folders refuse, anything it can't pin down asks, reads go through, and writes,
/// deletes and runs are allowed only inside work folders. It errs towards asking.
/// </summary>
public sealed partial class PowerShellAnalyser
{
    /// <summary>How deep <c>powershell -c "…"</c> inside a command is followed (§5.4).</summary>
    public const int MaxDepth = 3;

    private readonly IPowerShellParser _parser;
    private readonly PathZones _zones;
    private readonly PathEnvironment _env;

    public PowerShellAnalyser(IPowerShellParser parser, PathZones zones, PathEnvironment env)
    {
        _parser = parser;
        _zones = zones;
        _env = env;
    }

    public PathZones Zones => _zones;

    /// <summary>What <paramref name="command"/>, run in <paramref name="workingFolder"/>, does under <paramref name="profile"/>.</summary>
    public async Task<ShellAnalysis> AnalyzeAsync(string command, string workingFolder, PermissionProfile profile, CancellationToken ct)
    {
        var found = new Findings();
        var start = WinPath.Full(workingFolder, null, _env.Home);
        var cwds = new HashSet<string?>(StringComparer.OrdinalIgnoreCase) { start.Kind == WinPath.Kind.Local ? start.Path : null };
        await WalkAsync(command, cwds, found, 0, ct);
        return Decide(command, found, profile);
    }

    // -- what the command does ------------------------------------------------------------------

    private sealed record RawEffect(EffectKind Kind, string Path, bool Recursive, bool Children);

    private sealed class Findings
    {
        public List<RawEffect> Effects { get; } = [];

        public List<string> Unknown { get; } = [];

        public bool Network { get; set; }

        public void CantTell(string why)
        {
            if (!Unknown.Contains(why))
            {
                Unknown.Add(why);
            }
        }
    }

    private async Task WalkAsync(string command, HashSet<string?> cwds, Findings found, int depth, CancellationToken ct)
    {
        if (depth > MaxDepth)
        {
            found.CantTell("powershell inside powershell, nested too deep to follow");
            return;
        }

        var tree = await _parser.ParseAsync(command, ct);
        if (tree is null)
        {
            found.CantTell("PowerShell's parser isn't available on this computer");
            return;
        }

        if (tree["ok"] is not JsonValue ok || !ok.TryGetValue<bool>(out var parsed) || !parsed)
        {
            found.CantTell("PowerShell can't parse it: " + (Wire.Str(tree, "error") ?? "a syntax error"));
            return;
        }

        foreach (var member in Objects(tree["members"]))
        {
            Member(member, found);
        }

        foreach (var redirect in Objects(tree["exprRedirects"]))
        {
            Redirect(redirect, cwds, found);
        }

        var commands = Objects(tree["commands"]).OrderBy(c => Wire.Number(c["start"]) ?? 0).ToList();
        var pipes = commands.GroupBy(c => Wire.Number(c["pipe"]) ?? -1)
            .ToDictionary(g => g.Key, g => g.OrderBy(c => Wire.Number(c["index"]) ?? 0).ToList());
        // A change of folder that isn't at the top of the script (in a loop, a branch, a block)
        // may happen before any command: then no command's folder is certain.
        if (commands.Any(c => IsLocation(CanonicalName(c)) && !(Bool(c, "top") && !Bool(c, "inBlock"))))
        {
            cwds.Add(null);
        }

        foreach (var c in commands)
        {
            await CommandAsync(c, pipes, cwds, found, depth, ct);
        }
    }

    private static IEnumerable<JsonObject> Objects(JsonNode? node) =>
        node is JsonArray list ? list.OfType<JsonObject>() : node is JsonObject one ? [one] : [];

    private static bool Bool(JsonObject o, string key) => o[key] is JsonValue v && v.TryGetValue<bool>(out var b) && b;

    private static string CanonicalName(JsonObject c)
    {
        var first = c["first"] as JsonObject;
        var raw = first is not null && Wire.Str(first, "t") == "str" ? Wire.Str(first, "v") ?? "" : "";
        return Canonical(raw);
    }

    /// <summary>A command's name in lower case, aliases resolved, <c>.exe</c> dropped.</summary>
    internal static string Canonical(string raw)
    {
        var name = raw.Trim().ToLowerInvariant();
        if (name.EndsWith(".exe", StringComparison.Ordinal) && !name.Contains('\\') && !name.Contains('/'))
        {
            return name[..^4]; // where.exe, sc.exe: the program, never PowerShell's alias of that name
        }

        return Aliases.TryGetValue(name, out var cmdlet) ? cmdlet : name;
    }

    private static bool IsLocation(string name) => name is "set-location" or "push-location" or "pop-location";

    private async Task CommandAsync(
        JsonObject c, Dictionary<double, List<JsonObject>> pipes, HashSet<string?> cwds, Findings found, int depth, CancellationToken ct)
    {
        var first = c["first"] as JsonObject;
        var invocation = Wire.Str(c, "inv") ?? "Unknown";
        var args = Objects(c["args"]).ToList();
        if (first is null || Wire.Str(first, "t") != "str" || (invocation is "Ampersand" or "Dot" && string.IsNullOrEmpty(Wire.Str(first, "v"))))
        {
            found.CantTell("runs a command whose name is computed when it runs");
            return;
        }

        foreach (var redirect in Objects(c["redirects"]))
        {
            Redirect(redirect, cwds, found);
        }

        var raw = Wire.Str(first, "v") ?? "";
        var name = Canonical(raw);
        if (Network.Contains(name))
        {
            found.Network = true;
        }

        if (LooksLikePath(raw) || invocation == "Dot")
        {
            var program = Path.GetFileNameWithoutExtension(raw.Replace('/', '\\').Split('\\')[^1]).ToLowerInvariant();
            if (program is "powershell" or "pwsh" or "cmd")
            {
                name = program; // C:\Windows\System32\cmd.exe /c …: as cmd
            }
            else
            {
                foreach (var cwd in cwds)
                {
                    AddPath(raw, cwd, EffectKind.Run, false, literal: true, found);
                }

                return;
            }
        }

        var splatted = args.Any(a => Wire.Str(a, "t") == "splat");
        var piped = (Wire.Number(c["index"]) ?? 0) > 0;
        var prev = Wire.Str(c, "prev") ?? "";
        if (IsLocation(name))
        {
            Location(name, c, args, cwds, found);
            return;
        }

        if (Cmdlets.TryGetValue(name, out var spec))
        {
            if (splatted && spec.Changes)
            {
                found.CantTell($"splatting (@…) into {name}, whose paths it then can't see");
                return;
            }

            Cmdlet(name, spec, c, args, pipes, piped, prev, cwds, found);
            return;
        }

        if (Dangerous.TryGetValue(name, out var why))
        {
            found.CantTell(why);
            return;
        }

        if (name is "powershell" or "pwsh")
        {
            await NestedPowerShellAsync(args, cwds, found, depth, ct);
            return;
        }

        if (name == "cmd")
        {
            NestedCmd(args, cwds, found);
            return;
        }

        if (name == "foreach-object")
        {
            ForEachObject(args, found);
            return;
        }

        if (name.Contains('-'))
        {
            // A cmdlet it doesn't know: read-only verbs read their path arguments; any other verb
            // can't be told (Set-, New-, Remove-, Start-, Invoke-, Register-, …).
            var verb = name[..name.IndexOf('-')];
            if (ReadOnlyVerbs.Contains(verb))
            {
                foreach (var value in Values(args, ParamRole.Read, found, name))
                {
                    foreach (var cwd in cwds)
                    {
                        AddPath(value.Text, cwd, EffectKind.Read, false, value.Literal, found);
                    }
                }

                return;
            }

            found.CantTell($"{name} is a command it doesn't know to be read-only");
            return;
        }

        Native(name, args, cwds, found);
    }

    // -- cmdlets --------------------------------------------------------------------------------

    private enum ParamRole
    {
        Skip,
        Read,
        Write,
        Delete,
        Run,
    }

    /// <param name="Positional">The role of each positional argument; the last one repeats.</param>
    /// <param name="Named">Named parameters (full names, lower case) that take a value, and that value's role.</param>
    /// <param name="Changes">Writes, deletes or runs something.</param>
    /// <param name="BindsPathFromPipeline">Piped input becomes its path (Remove-Item, Copy-Item, …), not its content (Set-Content).</param>
    private sealed record CmdletSpec(ParamRole[] Positional, Dictionary<string, ParamRole> Named, bool Changes, bool BindsPathFromPipeline);

    private static Dictionary<string, ParamRole> N(params (string Name, ParamRole Role)[] named) =>
        named.ToDictionary(n => n.Name, n => n.Role, StringComparer.OrdinalIgnoreCase);

    private static readonly (string, ParamRole)[] CommonValues =
    [
        ("filter", ParamRole.Skip), ("include", ParamRole.Skip), ("exclude", ParamRole.Skip), ("encoding", ParamRole.Skip),
        ("erroraction", ParamRole.Skip), ("errorvariable", ParamRole.Skip), ("warningaction", ParamRole.Skip),
        ("informationaction", ParamRole.Skip), ("outvariable", ParamRole.Skip), ("pipelinevariable", ParamRole.Skip),
        ("depth", ParamRole.Skip), ("credential", ParamRole.Skip), ("stream", ParamRole.Skip), ("attributes", ParamRole.Skip),
    ];

    private static CmdletSpec Reads(params (string, ParamRole)[] more) =>
        new([ParamRole.Read], N([("path", ParamRole.Read), ("literalpath", ParamRole.Read), ("pspath", ParamRole.Read), .. more, .. CommonValues]), false, false);

    private static readonly Dictionary<string, CmdletSpec> Cmdlets = new(StringComparer.Ordinal)
    {
        // Read their paths.
        ["get-childitem"] = Reads(("name", ParamRole.Skip)),
        ["get-item"] = Reads(),
        ["get-content"] = Reads(("totalcount", ParamRole.Skip), ("tail", ParamRole.Skip), ("head", ParamRole.Skip), ("first", ParamRole.Skip), ("readcount", ParamRole.Skip), ("delimiter", ParamRole.Skip)),
        ["test-path"] = Reads(("pathtype", ParamRole.Skip), ("olderthan", ParamRole.Skip), ("newerthan", ParamRole.Skip)),
        ["get-filehash"] = Reads(("algorithm", ParamRole.Skip)),
        ["select-string"] = new([ParamRole.Skip, ParamRole.Read], N([("pattern", ParamRole.Skip), ("path", ParamRole.Read), ("literalpath", ParamRole.Read), ("context", ParamRole.Skip), .. CommonValues]), false, false),
        ["resolve-path"] = Reads(("relativebasepath", ParamRole.Read)),
        ["get-acl"] = Reads(),
        ["import-csv"] = Reads(("delimiter", ParamRole.Skip), ("header", ParamRole.Skip)),
        ["import-clixml"] = Reads(),
        ["get-itemproperty"] = Reads(("name", ParamRole.Skip)),
        ["get-itempropertyvalue"] = Reads(("name", ParamRole.Skip)),
        ["convert-path"] = Reads(),
        ["format-hex"] = Reads(("count", ParamRole.Skip), ("offset", ParamRole.Skip)),
        ["select-xml"] = new([ParamRole.Skip, ParamRole.Read], N([("xpath", ParamRole.Skip), ("path", ParamRole.Read), ("literalpath", ParamRole.Read), ("namespace", ParamRole.Skip), .. CommonValues]), false, false),
        ["get-authenticodesignature"] = Reads(),
        ["import-powershelldatafile"] = Reads(),
        ["split-path"] = new([ParamRole.Skip], N([("path", ParamRole.Skip), ("literalpath", ParamRole.Skip), .. CommonValues]), false, false),
        ["join-path"] = new([ParamRole.Skip], N([("path", ParamRole.Skip), ("childpath", ParamRole.Skip), .. CommonValues]), false, false),
        // Write.
        ["set-content"] = new([ParamRole.Write, ParamRole.Skip], N([("path", ParamRole.Write), ("literalpath", ParamRole.Write), ("value", ParamRole.Skip), .. CommonValues]), true, false),
        ["add-content"] = new([ParamRole.Write, ParamRole.Skip], N([("path", ParamRole.Write), ("literalpath", ParamRole.Write), ("value", ParamRole.Skip), .. CommonValues]), true, false),
        ["out-file"] = new([ParamRole.Write, ParamRole.Skip], N([("filepath", ParamRole.Write), ("literalpath", ParamRole.Write), ("width", ParamRole.Skip), ("inputobject", ParamRole.Skip), .. CommonValues]), true, false),
        ["clear-content"] = new([ParamRole.Write], N([("path", ParamRole.Write), ("literalpath", ParamRole.Write), .. CommonValues]), true, true),
        ["new-item"] = new([ParamRole.Write], N([("path", ParamRole.Write), ("name", ParamRole.Skip), ("itemtype", ParamRole.Skip), ("type", ParamRole.Skip), ("value", ParamRole.Skip), ("target", ParamRole.Skip), .. CommonValues]), true, false),
        ["export-csv"] = new([ParamRole.Write], N([("path", ParamRole.Write), ("literalpath", ParamRole.Write), ("delimiter", ParamRole.Skip), ("inputobject", ParamRole.Skip), .. CommonValues]), true, false),
        ["export-clixml"] = new([ParamRole.Write], N([("path", ParamRole.Write), ("literalpath", ParamRole.Write), ("inputobject", ParamRole.Skip), .. CommonValues]), true, false),
        ["tee-object"] = new([ParamRole.Write], N([("filepath", ParamRole.Write), ("literalpath", ParamRole.Write), ("variable", ParamRole.Skip), ("inputobject", ParamRole.Skip), .. CommonValues]), true, false),
        ["copy-item"] = new([ParamRole.Read, ParamRole.Write], N([("path", ParamRole.Read), ("literalpath", ParamRole.Read), ("destination", ParamRole.Write), .. CommonValues]), true, true),
        ["move-item"] = new([ParamRole.Delete, ParamRole.Write], N([("path", ParamRole.Delete), ("literalpath", ParamRole.Delete), ("destination", ParamRole.Write), .. CommonValues]), true, true),
        ["rename-item"] = new([ParamRole.Delete, ParamRole.Skip], N([("path", ParamRole.Delete), ("literalpath", ParamRole.Delete), ("newname", ParamRole.Skip), .. CommonValues]), true, true),
        ["expand-archive"] = new([ParamRole.Read, ParamRole.Write], N([("path", ParamRole.Read), ("literalpath", ParamRole.Read), ("destinationpath", ParamRole.Write), .. CommonValues]), true, false),
        ["compress-archive"] = new([ParamRole.Read, ParamRole.Write], N([("path", ParamRole.Read), ("literalpath", ParamRole.Read), ("destinationpath", ParamRole.Write), ("compressionlevel", ParamRole.Skip), .. CommonValues]), true, false),
        // Delete.
        ["remove-item"] = new([ParamRole.Delete], N([("path", ParamRole.Delete), ("literalpath", ParamRole.Delete), .. CommonValues]), true, true),
        // Run.
        ["start-process"] = new([ParamRole.Run, ParamRole.Skip], N([("filepath", ParamRole.Run), ("argumentlist", ParamRole.Skip), ("args", ParamRole.Skip), ("workingdirectory", ParamRole.Skip), ("windowstyle", ParamRole.Skip), ("redirectstandardoutput", ParamRole.Write), ("redirectstandarderror", ParamRole.Write), ("redirectstandardinput", ParamRole.Read), .. CommonValues]), true, false),
        ["invoke-item"] = new([ParamRole.Run], N([("path", ParamRole.Run), ("literalpath", ParamRole.Run), .. CommonValues]), true, true),
        // Change nothing on disk (their script blocks are read on their own).
        ["write-output"] = Nothing(), ["write-host"] = Nothing(), ["write-verbose"] = Nothing(), ["write-debug"] = Nothing(),
        ["write-warning"] = Nothing(), ["write-error"] = Nothing(), ["write-information"] = Nothing(), ["out-null"] = Nothing(),
        ["out-host"] = Nothing(), ["out-string"] = Nothing(), ["out-default"] = Nothing(), ["format-table"] = Nothing(),
        ["format-list"] = Nothing(), ["format-wide"] = Nothing(), ["format-custom"] = Nothing(), ["select-object"] = Nothing(),
        ["where-object"] = Nothing(), ["sort-object"] = Nothing(), ["group-object"] = Nothing(), ["measure-object"] = Nothing(),
        ["compare-object"] = Nothing(), ["get-date"] = Nothing(), ["get-process"] = Nothing(), ["get-service"] = Nothing(),
        ["get-command"] = Nothing(), ["get-help"] = Nothing(), ["get-member"] = Nothing(), ["get-location"] = Nothing(),
        ["get-variable"] = Nothing(), ["set-variable"] = Nothing(), ["new-variable"] = Nothing(), ["get-host"] = Nothing(),
        ["start-sleep"] = Nothing(), ["get-history"] = Nothing(), ["clear-host"] = Nothing(), ["get-psdrive"] = Nothing(),
        ["get-computerinfo"] = Nothing(), ["get-culture"] = Nothing(), ["get-uptime"] = Nothing(), ["get-random"] = Nothing(),
        ["get-ciminstance"] = Nothing(), ["get-wmiobject"] = Nothing(), ["get-netadapter"] = Nothing(), ["get-netipaddress"] = Nothing(),
        ["get-module"] = Nothing(), ["get-hotfix"] = Nothing(), ["get-timezone"] = Nothing(), ["get-alias"] = Nothing(),
        ["test-connection"] = Nothing(), ["test-netconnection"] = Nothing(), ["resolve-dnsname"] = Nothing(),
        ["get-eventlog"] = Nothing(), ["get-winevent"] = Nothing(), ["measure-command"] = Nothing(), ["get-unique"] = Nothing(),
        ["get-clipboard"] = Nothing(), ["set-clipboard"] = Nothing(), ["convertto-json"] = Nothing(), ["convertfrom-json"] = Nothing(),
        ["convertto-csv"] = Nothing(), ["convertfrom-csv"] = Nothing(), ["convertto-html"] = Nothing(), ["convertto-xml"] = Nothing(),
        ["convertfrom-stringdata"] = Nothing(), ["get-filehash-string"] = Nothing(), ["out-gridview"] = Nothing(),
        ["get-psreadlineoption"] = Nothing(), ["get-executionpolicy"] = Nothing(), ["get-localuser"] = Nothing(),
        ["get-scheduledtask"] = Nothing(), ["get-netfirewallrule"] = Nothing(), ["get-disk"] = Nothing(), ["get-volume"] = Nothing(),
        ["get-partition"] = Nothing(), ["get-printer"] = Nothing(), ["get-package"] = Nothing(), ["write-progress"] = Nothing(),
        ["invoke-webrequest"] = Web(), ["invoke-restmethod"] = Web(),
    };

    private static CmdletSpec Nothing() => new([ParamRole.Skip], N(), false, false);

    /// <summary>Downloads: the network; <c>-OutFile</c> is a write (§5.3 rule 5).</summary>
    private static CmdletSpec Web() =>
        new([ParamRole.Skip], N([("outfile", ParamRole.Write), ("infile", ParamRole.Read), ("uri", ParamRole.Skip), ("method", ParamRole.Skip), ("body", ParamRole.Skip), ("headers", ParamRole.Skip), ("contenttype", ParamRole.Skip), ("useragent", ParamRole.Skip), ("timeoutsec", ParamRole.Skip), .. CommonValues]), false, false);

    private static readonly HashSet<string> ReadOnlyVerbs = new(StringComparer.Ordinal)
    {
        "get", "test", "select", "measure", "find", "compare", "convertto", "convertfrom", "resolve", "split", "join", "show", "search", "read", "out", "wait",
    };

    private void Cmdlet(
        string name, CmdletSpec spec, JsonObject c, List<JsonObject> args, Dictionary<double, List<JsonObject>> pipes,
        bool piped, string prev, HashSet<string?> cwds, Findings found)
    {
        var recursive = HasSwitch(args, "recurse");
        if (name == "new-item" && ValueOf(args, "itemtype", "type") is { } type
            && type.ToLowerInvariant() is "symboliclink" or "junction" or "hardlink")
        {
            found.CantTell("makes a link, which can point anywhere");
            return;
        }

        if (name == "start-process" && ValueOf(args, "verb") is { } verb && verb.Equals("runas", StringComparison.OrdinalIgnoreCase))
        {
            found.CantTell("asks for administrator rights (Start-Process -Verb RunAs)");
            return;
        }

        var values = Values(args, spec, found, name).ToList();
        var explicitPath = values.Any(v => v.Role is not ParamRole.Skip);
        if (piped && spec.BindsPathFromPipeline)
        {
            var source = PipedSource(c, pipes, found);
            if (source is null)
            {
                return; // CantTell said why
            }

            var role = spec.Positional[0];
            foreach (var (text, children, sourceRecursive) in source)
            {
                foreach (var cwd in cwds)
                {
                    AddPath(text, cwd, KindOf(role), recursive || sourceRecursive, literal: false, found, children);
                }
            }
        }
        else if (piped && spec.Changes && !explicitPath && prev.Length > 0)
        {
            found.CantTell($"{name} gets its path from the pipeline, which it can't follow");
            return;
        }

        if (name == "new-item" && ValueOf(args, "name") is { } child)
        {
            values = values.Select(v => v.Role == ParamRole.Write ? v with { Text = v.Text.TrimEnd('\\', '/') + "\\" + child } : v).ToList();
            if (!values.Any(v => v.Role == ParamRole.Write))
            {
                values.Add(new PathValue(child, true, ParamRole.Write));
            }
        }

        if (name == "rename-item" && ValueOf(args, "newname") is { } newName && (newName.Contains('\\') || newName.Contains('/') || newName.Contains("..")))
        {
            found.CantTell("Rename-Item to a name with a folder in it");
            return;
        }

        if (name == "start-process")
        {
            // A program by name (notepad, git) runs in the working folder; a path runs there.
            var folder = ValueOf(args, "workingdirectory");
            foreach (var v in values.Where(v => v.Role == ParamRole.Run))
            {
                if (LooksLikePath(v.Text))
                {
                    foreach (var cwd in cwds)
                    {
                        AddPath(v.Text, cwd, EffectKind.Run, false, v.Literal, found);
                    }
                }
                else
                {
                    var program = Canonical(v.Text);
                    if (Dangerous.TryGetValue(program, out var why) || program is "powershell" or "pwsh" or "cmd")
                    {
                        found.CantTell(why ?? $"starts {program} with arguments it can't read");
                        return;
                    }

                    foreach (var cwd in cwds)
                    {
                        AddPath(folder ?? ".", cwd, EffectKind.Run, false, literal: true, found);
                    }
                }
            }

            values = values.Where(v => v.Role != ParamRole.Run).ToList();
        }

        foreach (var v in values.Where(v => v.Role != ParamRole.Skip))
        {
            foreach (var cwd in cwds)
            {
                AddPath(v.Text, cwd, KindOf(v.Role), recursive, v.Literal, found);
            }
        }

        if (name is "get-childitem" && !piped && !values.Any(v => v.Role == ParamRole.Read))
        {
            foreach (var cwd in cwds)
            {
                AddPath(".", cwd, EffectKind.Read, recursive, literal: true, found);
            }
        }

        if (name == "new-item" && !values.Any(v => v.Role == ParamRole.Write))
        {
            foreach (var cwd in cwds)
            {
                AddPath(".", cwd, EffectKind.Write, false, literal: true, found);
            }
        }
    }

    private static EffectKind KindOf(ParamRole role) => role switch
    {
        ParamRole.Read => EffectKind.Read,
        ParamRole.Delete => EffectKind.Delete,
        ParamRole.Run => EffectKind.Run,
        _ => EffectKind.Write,
    };

    /// <summary>
    /// The paths a piped delete or write works on (§4.4): only <c>Get-ChildItem &lt;literal path&gt; |
    /// [Where-Object|Sort-Object|Select-Object …] | Remove-Item</c> (and <c>Get-Item</c>), else can't tell.
    /// </summary>
    private List<(string Text, bool Children, bool Recursive)>? PipedSource(JsonObject c, Dictionary<double, List<JsonObject>> pipes, Findings found)
    {
        var index = (int)(Wire.Number(c["index"]) ?? 0);
        if (!pipes.TryGetValue(Wire.Number(c["pipe"]) ?? -1, out var pipe) || index >= pipe.Count || !ReferenceEquals(pipe[index], c) && pipe.Count <= index)
        {
            found.CantTell("a pipeline it can't follow");
            return null;
        }

        for (var i = index - 1; i >= 0; i--)
        {
            var before = pipe[i];
            var name = CanonicalName(before);
            if ((int)(Wire.Number(before["index"]) ?? -1) != i)
            {
                break; // an expression in between ('C:\x' | Remove-Item)
            }

            if (name is "where-object" or "sort-object" or "select-object")
            {
                continue;
            }

            if (name is "get-childitem" or "get-item" && i == 0)
            {
                var args = Objects(before["args"]).ToList();
                if (args.Any(a => Wire.Str(a, "t") == "splat"))
                {
                    break;
                }

                var unknownBefore = found.Unknown.Count;
                var paths = Values(args, Cmdlets[name], found, name).Where(v => v.Role == ParamRole.Read).ToList();
                if (found.Unknown.Count > unknownBefore)
                {
                    found.CantTell("piped from a Get-ChildItem whose path isn't written out");
                    return null;
                }

                var children = name == "get-childitem";
                var sourceRecursive = HasSwitch(args, "recurse");
                return paths.Count == 0 ? [(".", children, sourceRecursive)] : paths.Select(p => (p.Text, children, sourceRecursive)).ToList();
            }

            break;
        }

        found.CantTell($"{CanonicalName(c)} gets its paths from a pipeline it can't follow");
        return null;
    }

    private void Location(string name, JsonObject c, List<JsonObject> args, HashSet<string?> cwds, Findings found)
    {
        var certain = Bool(c, "top") && !Bool(c, "inBlock");
        if (name == "pop-location")
        {
            cwds.Add(null);
            return;
        }

        var values = Values(args, new CmdletSpec([ParamRole.Read], N(("path", ParamRole.Read), ("literalpath", ParamRole.Read), ("stackname", ParamRole.Skip)), false, false), found, name)
            .Where(v => v.Role == ParamRole.Read).ToList();
        if (values.Count == 0)
        {
            cwds.Add(name == "set-location" && args.Count == 0 ? _env.Home : null);
            return;
        }

        var target = values[0];
        // The folder may or may not change (a cd that fails leaves it): later commands must be fine in all.
        foreach (var cwd in cwds.ToList())
        {
            if (!certain || target.Text == "-" || target.Text == "+" || WinPath.WildcardAt(target.Text) >= 0)
            {
                cwds.Add(null);
                continue;
            }

            var (kind, full) = WinPath.Full(target.Text, cwd, _env.Home);
            cwds.Add(kind == WinPath.Kind.Local ? _zones.Real(full) : null);
        }
    }

    private static void ForEachObject(List<JsonObject> args, Findings found)
    {
        // ForEach-Object { … } is read through its block; ForEach-Object Delete calls a method by name.
        foreach (var a in args)
        {
            var t = Wire.Str(a, "t");
            if (t == "param")
            {
                var p = (Wire.Str(a, "name") ?? "").ToLowerInvariant();
                if ("membername".StartsWith(p, StringComparison.Ordinal) && p.Length > 0)
                {
                    found.CantTell("ForEach-Object calls a method by name");
                    return;
                }

                continue;
            }

            if (t is "str" or "expand" or "var" or "other")
            {
                found.CantTell("ForEach-Object calls a method by name");
                return;
            }
        }
    }

    // -- arguments ------------------------------------------------------------------------------

    private sealed record PathValue(string Text, bool Literal, ParamRole Role);

    private IEnumerable<PathValue> Values(List<JsonObject> args, ParamRole everyPositional, Findings found, string name) =>
        Values(args, new CmdletSpec([everyPositional], N([("path", everyPositional), ("literalpath", everyPositional), .. CommonValues]), false, false), found, name);

    /// <summary>
    /// The arguments with their role: positional ones by position, named ones by their parameter
    /// (prefixes count, as in PowerShell). A parameter it doesn't know is taken as a switch, so a
    /// value after it is read as a path: more paths than needed, never fewer.
    /// </summary>
    private IEnumerable<PathValue> Values(List<JsonObject> args, CmdletSpec spec, Findings found, string name)
    {
        var position = 0;
        for (var i = 0; i < args.Count; i++)
        {
            var a = args[i];
            if (Wire.Str(a, "t") == "param")
            {
                var given = (Wire.Str(a, "name") ?? "").ToLowerInvariant();
                var known = spec.Named.Keys.FirstOrDefault(k => k.Equals(given, StringComparison.OrdinalIgnoreCase))
                    ?? spec.Named.Keys.FirstOrDefault(k => given.Length >= 2 && k.StartsWith(given, StringComparison.OrdinalIgnoreCase));
                if (known is null)
                {
                    continue; // a switch (-Recurse, -Force, -WhatIf, …)
                }

                var role = spec.Named[known];
                var literal = known is "literalpath" or "pspath";
                if (a["arg"] is JsonObject inline)
                {
                    foreach (var v in Texts(inline, found, name, role))
                    {
                        yield return new PathValue(v.Text, v.Literal || literal, role);
                    }
                }
                else if (i + 1 < args.Count && Wire.Str(args[i + 1], "t") != "param")
                {
                    i++;
                    foreach (var v in Texts(args[i], found, name, role))
                    {
                        yield return new PathValue(v.Text, v.Literal || literal, role);
                    }
                }

                continue;
            }

            var positional = spec.Positional[Math.Min(position, spec.Positional.Length - 1)];
            position++;
            foreach (var v in Texts(a, found, name, positional))
            {
                yield return new PathValue(v.Text, v.Literal, positional);
            }
        }
    }

    /// <summary>
    /// The text of one argument. <c>Literal</c> means it can't hold wildcards (it came through
    /// -LiteralPath); a variable from §4.4's list is expanded, any other makes it can't tell.
    /// </summary>
    private IEnumerable<(string Text, bool Literal)> Texts(JsonObject a, Findings found, string name, ParamRole role)
    {
        switch (Wire.Str(a, "t"))
        {
            case "str":
            case "const":
                yield return (Wire.Str(a, "v") ?? "", false);
                yield break;
            case "array":
                foreach (var item in Objects(a["items"]))
                {
                    foreach (var v in Texts(item, found, name, role))
                    {
                        yield return v;
                    }
                }

                yield break;
            case "var":
                var variable = Wire.Str(a, "v") ?? "";
                if (role == ParamRole.Skip)
                {
                    yield break;
                }

                if (_env.PowerShellVariable(variable) is { } value)
                {
                    yield return (value, false);
                    yield break;
                }

                found.CantTell($"variable ${variable} used as a path ({name})");
                yield break;
            case "expand":
                if (role == ParamRole.Skip)
                {
                    yield break;
                }

                var text = Wire.Str(a, "v") ?? "";
                if (Bool(a, "sub") || text.Contains('`'))
                {
                    found.CantTell($"a path built when it runs ({name})");
                    yield break;
                }

                foreach (var name2 in (a["vars"] as JsonArray ?? []).Select(n => n?.GetValue<string>() ?? ""))
                {
                    if (_env.PowerShellVariable(name2) is not { } expanded)
                    {
                        found.CantTell($"variable ${name2} used as a path ({name})");
                        yield break;
                    }

                    text = Regex.Replace(text, @"\$\{?" + Regex.Escape(name2) + @"\}?", expanded.Replace("$", "$$"), RegexOptions.IgnoreCase);
                }

                yield return (text, false);
                yield break;
            case "splat":
                found.CantTell($"splatting (@…) into {name}");
                yield break;
            default:
                if (role != ParamRole.Skip)
                {
                    found.CantTell($"a path built when it runs ({name})");
                }

                yield break;
        }
    }

    private static bool HasSwitch(List<JsonObject> args, string full) =>
        args.Any(a => Wire.Str(a, "t") == "param" && Wire.Str(a, "name") is { Length: >= 2 } n
            && full.StartsWith(n, StringComparison.OrdinalIgnoreCase)
            && !(a["arg"] is JsonObject v && Wire.Str(v, "t") == "var" && string.Equals(Wire.Str(v, "v"), "false", StringComparison.OrdinalIgnoreCase)));

    private static string? ValueOf(List<JsonObject> args, params string[] names)
    {
        for (var i = 0; i < args.Count; i++)
        {
            if (Wire.Str(args[i], "t") == "param" && Wire.Str(args[i], "name") is { Length: >= 2 } n
                && names.Any(full => full.StartsWith(n, StringComparison.OrdinalIgnoreCase)))
            {
                var value = args[i]["arg"] as JsonObject ?? (i + 1 < args.Count ? args[i + 1] : null);
                return value is not null && Wire.Str(value, "t") is "str" or "const" ? Wire.Str(value, "v") : null;
            }
        }

        return null;
    }

    private static bool LooksLikePath(string text) =>
        !text.Contains("://", StringComparison.Ordinal)
        && (DriveLetter().IsMatch(text) || text.Contains('\\') || text.StartsWith("./", StringComparison.Ordinal) || text.StartsWith("../", StringComparison.Ordinal)
            || text.StartsWith('~') || (text.Contains('/') && !text.StartsWith('/') && !text.StartsWith('-')));

    [GeneratedRegex(@"^[A-Za-z]:[\\/]")]
    private static partial Regex DriveLetter();

    /// <summary>Records what a path argument does, for every working folder the command may be in.</summary>
    private void AddPath(string text, string? cwd, EffectKind kind, bool recursive, bool literal, Findings found, bool children = false)
    {
        if (text.Length == 0)
        {
            return;
        }

        var path = text;
        var wildcard = literal ? -1 : WinPath.WildcardAt(path);
        if (wildcard >= 0)
        {
            // Matched on the folder before the first wildcard: what it matches is below it.
            var prefix = path[..wildcard].Replace('/', '\\');
            var cut = prefix.LastIndexOf('\\');
            if (path[wildcard..].Contains('\\') || path[wildcard..].Contains('/'))
            {
                found.CantTell($"a wildcard in the middle of a path ({text})");
                return;
            }

            path = cut < 0 ? "." : prefix[..(cut + 1)];
            if (path.Length == 2 && path[1] == ':')
            {
                path += "\\";
            }

            children = true;
        }

        var (pathKind, full) = WinPath.Full(path, cwd, _env.Home);
        switch (pathKind)
        {
            case WinPath.Kind.Unc:
                found.CantTell($"a network share ({text}): always asks");
                return;
            case WinPath.Kind.Provider:
                if (kind != EffectKind.Read)
                {
                    found.CantTell($"changes the registry or another provider ({text})");
                }

                return;
            case WinPath.Kind.Unknown:
                found.CantTell($"a path relative to a folder it can't tell ({text})");
                return;
        }

        found.Effects.Add(new RawEffect(kind, _zones.Real(full), recursive, children));
    }

    private void Redirect(JsonObject redirect, HashSet<string?> cwds, Findings found)
    {
        if (redirect["file"] is not JsonObject file)
        {
            return;
        }

        if (Wire.Str(file, "t") == "var" && string.Equals(Wire.Str(file, "v"), "null", StringComparison.OrdinalIgnoreCase))
        {
            return; // > $null
        }

        foreach (var (text, literal) in Texts(file, found, "a redirection", ParamRole.Write))
        {
            foreach (var cwd in cwds)
            {
                AddPath(text, cwd, EffectKind.Write, false, literal: true, found);
            }
        }
    }

    // -- .NET calls -----------------------------------------------------------------------------

    private static readonly HashSet<string> SafeTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "math", "system.math", "string", "system.string", "datetime", "system.datetime", "convert", "system.convert", "char", "int",
        "int32", "int64", "long", "double", "decimal", "guid", "system.guid", "regex", "system.text.regularexpressions.regex",
        "io.path", "system.io.path", "environment", "system.environment", "text.encoding", "system.text.encoding", "bitconverter",
        "timespan", "system.timespan", "uri", "system.uri", "version", "system.version", "datetimeoffset", "char[]", "bool",
        "net.dns", "system.net.dns", "array", "system.array", "string[]", "byte[]", "byte", "math]",
    };

    private static readonly HashSet<string> SafeMethods = new(StringComparer.OrdinalIgnoreCase)
    {
        "tostring", "trim", "trimstart", "trimend", "split", "replace", "contains", "startswith", "endswith", "tolower", "toupper",
        "tolowerinvariant", "toupperinvariant", "substring", "indexof", "lastindexof", "padleft", "padright", "equals", "gethashcode",
        "gettype", "format", "join", "compareto", "toarray", "containskey", "containsvalue", "getvalue", "where", "foreach", "add",
        "insert", "tostringinvariant", "adddays", "addhours", "addminutes", "addseconds", "tofiletime", "touniversaltime",
        "tolocaltime", "getfilename", "getextension", "getdirectoryname", "getfullpath", "combine", "getfolderpath",
        "getenvironmentvariable", "parse", "tryparse", "round", "floor", "ceiling", "max", "min", "abs", "pow", "sqrt", "match",
        "matches", "isnullorempty", "isnullorwhitespace", "newguid", "getbytes", "getstring", "tobase64string", "frombase64string",
        "getfilenamewithoutextension", "getrandomfilename", "gettemppath", "toint32", "toint64", "todouble", "toboolean",
        "isupper", "islower", "isdigit", "isletter", "getenumerator", "movenext", "count", "sort", "reverse", "indexofany",
        "normalize", "tochararray", "getlength", "getupperbound", "getlowerbound", "getaddresses", "gethostaddresses", "gethostentry",
    };

    private static void Member(JsonObject member, Findings found)
    {
        var name = Wire.Str(member, "member") ?? "";
        var text = Wire.Str(member, "text") ?? name;
        if (name.Length == 0)
        {
            found.CantTell($"calls a method whose name is computed ({text})");
            return;
        }

        if (Bool(member, "static"))
        {
            var type = (Wire.Str(member, "type") ?? "").Trim('[', ']');
            if (SafeTypes.Contains(type) && !name.StartsWith("set", StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            found.CantTell($"calls [{type}]::{name}");
            return;
        }

        if (name.StartsWith("download", StringComparison.OrdinalIgnoreCase) || name.StartsWith("upload", StringComparison.OrdinalIgnoreCase))
        {
            found.Network = true;
        }

        if (!SafeMethods.Contains(name))
        {
            found.CantTell($"calls .{name}(), which may change things");
        }
    }

    // -- programs -------------------------------------------------------------------------------

    private static readonly HashSet<string> ReadOnlyNatives = new(StringComparer.Ordinal)
    {
        "whoami", "hostname", "ipconfig", "systeminfo", "where", "tasklist", "netstat", "ver", "nslookup", "ping", "tracert",
        "pathping", "getmac", "nvidia-smi", "findstr", "fc", "tree", "more", "query", "quser", "arp", "chcp", "date", "time",
    };

    /// <summary>Developer tools that run in the working folder; their path arguments count as writes.</summary>
    private static readonly HashSet<string> KnownNatives = new(StringComparer.Ordinal)
    {
        "git", "dotnet", "npm", "npx", "pnpm", "yarn", "node", "python", "python3", "py", "pip", "pip3", "uv", "uvx", "cargo",
        "rustc", "rustup", "go", "make", "cmake", "msbuild", "nuget", "gh", "code", "docker", "java", "javac", "mvn", "gradle",
        "tsc", "deno", "bun", "claude", "rg", "fd", "7z", "tar", "curl", "ssh", "scp", "jq", "pytest", "ruff", "eslint", "prettier",
        "vite", "vitest", "playwright", "flutter", "dart", "kubectl", "terraform", "ffmpeg", "magick", "zip", "unzip", "wsl",
    };

    private static readonly HashSet<string> GitReads = new(StringComparer.Ordinal)
    {
        "status", "log", "diff", "show", "blame", "ls-files", "ls-tree", "rev-parse", "describe", "shortlog", "grep", "cat-file",
        "help", "version", "--version", "rev-list", "name-rev", "for-each-ref", "show-ref", "whatchanged",
    };

    private void Native(string name, List<JsonObject> args, HashSet<string?> cwds, Findings found)
    {
        var texts = new List<string>();
        foreach (var a in args)
        {
            var t = Wire.Str(a, "t");
            if (t == "param")
            {
                texts.Add("-" + Wire.Str(a, "name"));
                if (a["arg"] is JsonObject inline)
                {
                    texts.AddRange(Texts(inline, found, name, ParamRole.Write).Select(v => v.Text));
                }

                continue;
            }

            if (t is "str" or "const")
            {
                texts.Add(Wire.Str(a, "v") ?? "");
                continue;
            }

            if (t is "var" or "expand")
            {
                var values = Texts(a, found, name, ParamRole.Write).ToList();
                texts.AddRange(values.Select(v => v.Text));
                continue;
            }

            found.CantTell($"{name} with an argument built when it runs");
            return;
        }

        if (name == "git")
        {
            Git(texts, cwds, found);
            return;
        }

        var paths = texts.Where(LooksLikePath).ToList();
        if (ReadOnlyNatives.Contains(name))
        {
            foreach (var p in paths)
            {
                foreach (var cwd in cwds)
                {
                    AddPath(p, cwd, EffectKind.Read, false, literal: true, found);
                }
            }

            return;
        }

        if (!KnownNatives.Contains(name) && paths.Count > 0)
        {
            found.CantTell($"{name} is a program it doesn't know, with paths in its arguments");
            return;
        }

        foreach (var cwd in cwds)
        {
            AddPath(".", cwd, EffectKind.Run, false, literal: true, found);
            foreach (var p in paths)
            {
                AddPath(p, cwd, EffectKind.Write, false, literal: true, found);
            }
        }
    }

    private void Git(List<string> args, HashSet<string?> cwds, Findings found)
    {
        var folders = new HashSet<string?>(cwds, StringComparer.OrdinalIgnoreCase);
        var i = 0;
        while (i < args.Count && args[i].StartsWith('-'))
        {
            var flag = args[i].ToLowerInvariant();
            if (flag == "-c" && i + 1 < args.Count)
            {
                var value = args[i + 1].ToLowerInvariant();
                if (value.Contains("alias.") || value.Contains("core.") || value.Contains("hooks") || value.Contains("filter.") || value.Contains("credential"))
                {
                    found.CantTell("git -c with settings that can run programs");
                    return;
                }

                i += 2;
                continue;
            }

            if (args[i] == "-C" && i + 1 < args.Count)
            {
                var target = args[i + 1];
                folders = new HashSet<string?>(folders.Select(f =>
                {
                    var (kind, full) = WinPath.Full(target, f, _env.Home);
                    return kind == WinPath.Kind.Local ? _zones.Real(full) : null;
                }), StringComparer.OrdinalIgnoreCase);
                i += 2;
                continue;
            }

            if (flag.StartsWith("--git-dir", StringComparison.Ordinal) || flag.StartsWith("--work-tree", StringComparison.Ordinal) || flag.StartsWith("--exec-path", StringComparison.Ordinal))
            {
                found.CantTell($"git {flag} points git somewhere else");
                return;
            }

            i++;
        }

        var sub = i < args.Count ? args[i].ToLowerInvariant() : "";
        var rest = args.Skip(i + 1).ToList();
        if (sub is "clone" or "pull" or "push" or "fetch" or "ls-remote" or "submodule")
        {
            found.Network = true;
        }

        var reads = GitReads.Contains(sub)
            || (sub == "branch" && !rest.Any(r => r.StartsWith('-') && r != "-a" && r != "-r" && r != "-v" && r != "-vv" && r != "--list" && r != "--all"))
            || (sub == "remote" && (rest.Count == 0 || rest[0] is "-v" or "show" or "get-url"))
            || (sub == "tag" && (rest.Count == 0 || rest[0] is "-l" or "--list"))
            || (sub == "config" && rest.Any(r => r is "--get" or "--list" or "-l" or "--get-all"))
            || (sub == "stash" && rest.Count > 0 && rest[0] is "list" or "show")
            || (sub == "worktree" && rest.Count > 0 && rest[0] == "list")
            || sub.Length == 0;
        foreach (var folder in folders)
        {
            if (reads)
            {
                found.Effects.Add(new RawEffect(EffectKind.Read, folder ?? "", false, false));
                if (folder is null)
                {
                    found.CantTell("git in a folder it can't tell");
                }

                continue;
            }

            AddPath(".", folder, EffectKind.Run, false, literal: true, found);
            foreach (var p in rest.Where(LooksLikePath))
            {
                AddPath(p, folder, EffectKind.Write, false, literal: true, found);
            }
        }
    }

    private async Task NestedPowerShellAsync(List<JsonObject> args, HashSet<string?> cwds, Findings found, int depth, CancellationToken ct)
    {
        for (var i = 0; i < args.Count; i++)
        {
            var a = args[i];
            if (Wire.Str(a, "t") == "param")
            {
                var flag = (Wire.Str(a, "name") ?? "").ToLowerInvariant();
                if (flag is "noprofile" or "noninteractive" or "nologo" or "mta" or "sta" or "nop" or "noni")
                {
                    continue;
                }

                if (flag is "executionpolicy" or "ep" or "windowstyle" or "w" or "inputformat" or "outputformat" or "of" or "if")
                {
                    i++;
                    continue;
                }

                if (flag.StartsWith('e') && "encodedcommand".StartsWith(flag, StringComparison.Ordinal))
                {
                    found.CantTell("runs an encoded command (-EncodedCommand)");
                    return;
                }

                if (flag is "c" or "command" or "com")
                {
                    var rest = args.Skip(i + 1).ToList();
                    if (rest.Count == 0 || rest.Any(r => Wire.Str(r, "t") is not ("str" or "const")))
                    {
                        found.CantTell("powershell -Command with a command built when it runs");
                        return;
                    }

                    await WalkAsync(string.Join(' ', rest.Select(r => Wire.Str(r, "v"))), new HashSet<string?>(cwds, StringComparer.OrdinalIgnoreCase), found, depth + 1, ct);
                    return;
                }

                if (flag is "file" or "f")
                {
                    if (i + 1 < args.Count && Wire.Str(args[i + 1], "t") is "str" && Wire.Str(args[i + 1], "v") is { } script)
                    {
                        foreach (var cwd in cwds)
                        {
                            AddPath(script, cwd, EffectKind.Run, false, literal: true, found);
                        }

                        return;
                    }

                    found.CantTell("powershell -File with a script it can't tell");
                    return;
                }

                found.CantTell($"powershell -{flag}");
                return;
            }

            // powershell "text": the rest is the command.
            var tail = args.Skip(i).ToList();
            if (tail.Any(r => Wire.Str(r, "t") is not ("str" or "const")))
            {
                found.CantTell("powershell with a command built when it runs");
                return;
            }

            await WalkAsync(string.Join(' ', tail.Select(r => Wire.Str(r, "v"))), new HashSet<string?>(cwds, StringComparer.OrdinalIgnoreCase), found, depth + 1, ct);
            return;
        }

        found.CantTell("powershell reading commands from its input");
    }

    /// <summary>
    /// <c>cmd /c "…"</c> (§5.3): only a literal command without cmd's own operators and expansions
    /// (<c>&amp; | &lt; &gt; ^ % !</c>) is read: <c>del</c>, <c>erase</c>, <c>rd</c>, <c>rmdir</c>,
    /// <c>dir</c>, <c>type</c>, <c>echo</c>, <c>md</c>. Anything else can't be told.
    /// </summary>
    private void NestedCmd(List<JsonObject> args, HashSet<string?> cwds, Findings found)
    {
        var words = new List<string>();
        foreach (var a in args)
        {
            if (Wire.Str(a, "t") is "str" or "const")
            {
                words.Add(Wire.Str(a, "v") ?? "");
            }
            else if (Wire.Str(a, "t") == "param")
            {
                words.Add("-" + Wire.Str(a, "name"));
            }
            else
            {
                found.CantTell("cmd with an argument built when it runs");
                return;
            }
        }

        var at = words.FindIndex(w => w.Equals("/c", StringComparison.OrdinalIgnoreCase) || w.Equals("/k", StringComparison.OrdinalIgnoreCase));
        if (at < 0 || at + 1 >= words.Count)
        {
            found.CantTell("cmd without /c");
            return;
        }

        var line = string.Join(' ', words.Skip(at + 1));
        if (line.IndexOfAny(['&', '|', '<', '>', '^', '%', '!']) >= 0 || line.Count(ch => ch == '"') % 2 != 0)
        {
            found.CantTell("a cmd command with operators or variables it doesn't read");
            return;
        }

        var tokens = CmdTokens().Matches(line).Select(m => m.Value.Trim('"')).Where(t => t.Length > 0).ToList();
        if (tokens.Count == 0)
        {
            return;
        }

        var verb = tokens[0].ToLowerInvariant();
        var flags = tokens.Skip(1).Where(t => t.StartsWith('/')).Select(t => t.ToLowerInvariant()).ToList();
        var operands = tokens.Skip(1).Where(t => !t.StartsWith('/')).ToList();
        var (kind, recursive) = verb switch
        {
            "del" or "erase" => (EffectKind.Delete, flags.Contains("/s")),
            "rd" or "rmdir" => (EffectKind.Delete, true),
            "dir" or "type" => (EffectKind.Read, false),
            "md" or "mkdir" => (EffectKind.Write, false),
            "echo" or "ver" or "cd" or "chdir" or "set" or "where" or "whoami" or "hostname" => (EffectKind.Read, false),
            _ => (EffectKind.Run, false),
        };
        if (verb is not ("del" or "erase" or "rd" or "rmdir" or "dir" or "type" or "md" or "mkdir" or "echo" or "ver" or "cd" or "chdir" or "set" or "where" or "whoami" or "hostname"))
        {
            found.CantTell($"cmd /c {verb}");
            return;
        }

        if (verb is "echo" or "ver" or "set" or "cd" or "chdir" or "whoami" or "hostname" or "where")
        {
            return;
        }

        foreach (var operand in operands)
        {
            foreach (var cwd in cwds)
            {
                AddPath(operand, cwd, kind, recursive, literal: false, found);
            }
        }
    }

    [GeneratedRegex("\"[^\"]*\"|\\S+")]
    private static partial Regex CmdTokens();

    // -- the decision ---------------------------------------------------------------------------

    private ShellAnalysis Decide(string command, Findings found, PermissionProfile profile)
    {
        var shell = profile.Level("shell");
        var folders = profile.WorkFolders
            .Select(f => (Folder: f, Path: WinPath.Expand(f.Path, _env)))
            .Where(f => f.Path is not null && WinPath.Full(f.Path!, null, _env.Home).Kind == WinPath.Kind.Local)
            .Select(f => (f.Folder, Path: _zones.Real(WinPath.Collapse(f.Path!))))
            .ToList();

        var effects = new List<ShellEffect>();
        var verdict = Verdict.Allow;
        string? rule = null;
        var ruleKind = EffectKind.Read;
        foreach (var raw in found.Effects)
        {
            if (raw.Path.Length == 0)
            {
                continue;
            }

            var (v, why, folder) = _zones.Judge(raw.Path, raw.Kind, raw.Children, profile, folders);
            effects.Add(new ShellEffect(raw.Kind, raw.Path, raw.Recursive || raw.Children, folder?.Path, folder?.Recycle ?? false));
            // The strictest effect decides; at the same verdict a change says more than a read.
            if (rule is null || v > verdict || (v == verdict && raw.Kind != EffectKind.Read && ruleKind == EffectKind.Read))
            {
                verdict = v > verdict ? v : verdict;
                rule = why;
                ruleKind = raw.Kind;
            }
        }

        // The hard floor holds even for what can't be read: a command that names Anemo Desktop's own folders is refused.
        if (found.Unknown.Count > 0 && MentionsHardFloor(command))
        {
            return new ShellAnalysis(Verdict.Deny, effects, found.Unknown, "names Anemo Desktop's own folder, which no agent may touch", found.Network, profile.Version);
        }

        if (verdict == Verdict.Deny)
        {
            return new ShellAnalysis(verdict, effects, found.Unknown, rule!, found.Network, profile.Version);
        }

        if (shell is "deny")
        {
            return new ShellAnalysis(Verdict.Deny, effects, found.Unknown, "the shell is off in this computer's permission profile", found.Network, profile.Version);
        }

        // Unrestricted and Trusted (legacy): only the hard floor (rule 1); what can't be read is allowed (§5.3).
        if (shell is "allow" or "policy")
        {
            var why = shell == "allow" ? "Unrestricted: the whole computer is a work folder" : "as the Agent Permissions say (Trusted (legacy))";
            return new ShellAnalysis(Verdict.Allow, effects, found.Unknown, why, found.Network, profile.Version);
        }

        if (found.Unknown.Count > 0)
        {
            return new ShellAnalysis(Verdict.Ask, effects, found.Unknown, "can't tell what it does: " + found.Unknown[0], found.Network, profile.Version);
        }

        if (shell == "ask")
        {
            return new ShellAnalysis(Verdict.Ask, effects, found.Unknown, "this computer's permission profile asks before every command", found.Network, profile.Version);
        }

        return new ShellAnalysis(verdict, effects, found.Unknown, rule ?? "changes nothing on this computer", found.Network, profile.Version);
    }

    private bool MentionsHardFloor(string command) =>
        command.Contains("AnemoDesktop", StringComparison.OrdinalIgnoreCase) || command.Contains("Anemo Desktop", StringComparison.OrdinalIgnoreCase)
        || _zones.Protected.Where(p => p.Level == "hard").Any(p => command.Contains(p.Path, StringComparison.OrdinalIgnoreCase));

    // -- names ----------------------------------------------------------------------------------

    private static readonly Dictionary<string, string> Aliases = new(StringComparer.Ordinal)
    {
        ["rm"] = "remove-item", ["del"] = "remove-item", ["erase"] = "remove-item", ["ri"] = "remove-item", ["rd"] = "remove-item",
        ["rmdir"] = "remove-item", ["cd"] = "set-location", ["chdir"] = "set-location", ["sl"] = "set-location",
        ["pushd"] = "push-location", ["popd"] = "pop-location", ["ls"] = "get-childitem", ["dir"] = "get-childitem",
        ["gci"] = "get-childitem", ["cat"] = "get-content", ["gc"] = "get-content", ["type"] = "get-content", ["gi"] = "get-item",
        ["echo"] = "write-output", ["write"] = "write-output", ["cp"] = "copy-item", ["copy"] = "copy-item", ["cpi"] = "copy-item",
        ["mv"] = "move-item", ["move"] = "move-item", ["mi"] = "move-item", ["ren"] = "rename-item", ["rni"] = "rename-item",
        ["ni"] = "new-item", ["md"] = "new-item", ["mkdir"] = "new-item", ["sc"] = "set-content", ["ac"] = "add-content",
        ["clc"] = "clear-content", ["iex"] = "invoke-expression", ["icm"] = "invoke-command", ["saps"] = "start-process",
        ["start"] = "start-process", ["ii"] = "invoke-item", ["iwr"] = "invoke-webrequest", ["irm"] = "invoke-restmethod",
        ["wget"] = "invoke-webrequest", ["%"] = "foreach-object", ["foreach"] = "foreach-object", ["?"] = "where-object",
        ["where"] = "where-object", ["select"] = "select-object", ["sort"] = "sort-object", ["group"] = "group-object",
        ["measure"] = "measure-object", ["ft"] = "format-table", ["fl"] = "format-list", ["fw"] = "format-wide",
        ["gm"] = "get-member", ["gps"] = "get-process", ["ps"] = "get-process", ["gsv"] = "get-service", ["gcm"] = "get-command",
        ["pwd"] = "get-location", ["gl"] = "get-location", ["sleep"] = "start-sleep", ["tee"] = "tee-object", ["sls"] = "select-string",
        ["rvpa"] = "resolve-path", ["oh"] = "out-host", ["gv"] = "get-variable", ["sv"] = "set-variable", ["set"] = "set-variable",
        ["cls"] = "clear-host", ["clear"] = "clear-host", ["h"] = "get-history", ["history"] = "get-history", ["diff"] = "compare-object",
        ["compare"] = "compare-object", ["epcsv"] = "export-csv", ["ipcsv"] = "import-csv", ["sp"] = "set-itemproperty",
        ["rp"] = "remove-itemproperty", ["kill"] = "stop-process", ["spps"] = "stop-process", ["ipmo"] = "import-module",
        ["sajb"] = "start-job", ["curl"] = "curl", ["gp"] = "get-itemproperty", ["cvpa"] = "convert-path", ["fhx"] = "format-hex",
    };

    private static readonly Dictionary<string, string> Dangerous = new(StringComparer.Ordinal)
    {
        ["invoke-expression"] = "runs text as code (Invoke-Expression)",
        ["add-type"] = "compiles code (Add-Type)",
        ["invoke-command"] = "runs commands through remoting (Invoke-Command)",
        ["enter-pssession"] = "opens a remote session", ["new-pssession"] = "opens a remote session",
        ["start-job"] = "runs a background job", ["start-threadjob"] = "runs a background job",
        ["shutdown"] = "shuts the computer down", ["bcdedit"] = "changes the boot settings", ["reg"] = "changes the registry",
        ["regedit"] = "changes the registry", ["sc"] = "changes services", ["schtasks"] = "changes scheduled tasks",
        ["netsh"] = "changes the network or firewall", ["diskpart"] = "changes disks", ["format"] = "formats a disk",
        ["cipher"] = "wipes or encrypts files", ["takeown"] = "takes ownership of files", ["icacls"] = "changes file permissions",
        ["cacls"] = "changes file permissions", ["vssadmin"] = "changes shadow copies", ["wbadmin"] = "changes backups",
        ["net"] = "changes users or shares", ["net1"] = "changes users or shares", ["wmic"] = "runs WMI commands",
        ["runas"] = "runs as another user", ["msiexec"] = "installs software", ["certutil"] = "downloads or changes certificates",
        ["bitsadmin"] = "downloads files", ["mshta"] = "runs HTML applications", ["rundll32"] = "runs DLL code",
        ["regsvr32"] = "registers DLLs", ["wscript"] = "runs scripts", ["cscript"] = "runs scripts", ["sfc"] = "repairs system files",
        ["dism"] = "changes Windows images", ["bootrec"] = "changes the boot records", ["attrib"] = "changes file attributes",
        ["setx"] = "changes environment variables for good", ["taskkill"] = "stops processes", ["winget"] = "installs software",
        ["choco"] = "installs software", ["scoop"] = "installs software", ["robocopy"] = "copies (and may delete) many files",
        ["xcopy"] = "copies many files", ["bash"] = "runs a bash command", ["sh"] = "runs a shell command",
        ["mklink"] = "makes a link", ["powershell_ise"] = "opens the PowerShell editor",
    };

    private static readonly HashSet<string> Network = new(StringComparer.Ordinal)
    {
        "invoke-webrequest", "invoke-restmethod", "curl", "wget", "start-bitstransfer", "send-mailmessage", "test-connection",
        "test-netconnection", "ping", "ssh", "scp", "sftp", "ftp", "telnet", "nslookup", "resolve-dnsname", "tracert",
        "invoke-command", "enter-pssession", "new-pssession", "winget", "choco", "scoop", "certutil", "bitsadmin",
        "install-module", "install-package", "install-script", "update-module", "find-module", "npm", "pnpm", "yarn", "pip", "pip3",
        "nuget", "gh",
    };
}
