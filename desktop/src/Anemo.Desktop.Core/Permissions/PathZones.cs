namespace Anemo.Desktop.Core.Permissions;

/// <summary>The three verdicts, strictest last (spec 25 §5.2).</summary>
public enum Verdict
{
    Allow = 0,
    Ask = 1,
    Deny = 2,
}

/// <summary>What a command does to a path (§5.2 <c>effects</c>).</summary>
public enum EffectKind
{
    Read,
    Write,
    Delete,
    Run,
}

/// <summary>One protected folder of §4.3, at its place on this computer.</summary>
/// <param name="Key">The key the profile's <c>protected</c> levels use (<c>keys</c>, <c>browsers</c>, …).</param>
/// <param name="Level"><c>hard</c>, <c>deny</c> (adjustable to ask) or <c>ask</c>.</param>
/// <param name="ExactOnly">Only the folder itself is protected, not what is below it (the user folder, a drive's root).</param>
public sealed record ProtectedFolder(string Key, string Path, string Level, bool ExactOnly = false);

/// <summary>
/// Where a path falls (§4.3–4.4): the hard floor (Anemo Desktop's own data and install folders,
/// fixed in this code, on every profile), the deny-protected folders, the ask-protected ones,
/// a work folder, or the read-only rest. Protected folders are checked before the work folders,
/// and a delete that would take a protected folder with it counts as touching it.
/// </summary>
public sealed class PathZones
{
    private readonly IReadOnlyList<ProtectedFolder> _protected;
    private readonly Func<string, string> _resolve;

    /// <param name="resolveLinks">The path with every link and junction on the way followed (§4.4); identity in tests off Windows.</param>
    public PathZones(IReadOnlyList<ProtectedFolder> protectedFolders, Func<string, string> resolveLinks)
    {
        _protected = protectedFolders;
        _resolve = resolveLinks;
    }

    public IReadOnlyList<ProtectedFolder> Protected => _protected;

    /// <summary>The protected folders of §4.3 on a computer with these folders.</summary>
    public static IReadOnlyList<ProtectedFolder> For(PathEnvironment env, string dataFolder, string installFolder)
    {
        string J(string a, string b) => WinPath.Collapse(a.TrimEnd('\\') + "\\" + b);
        var drive = env.Windows.Length >= 2 ? env.Windows[..2] : "C:";
        return
        [
            new("anemo", WinPath.Collapse(dataFolder), "hard"),
            new("anemo", WinPath.Collapse(installFolder), "hard"),
            new("keys", J(env.Home, ".ssh"), "deny"),
            new("keys", J(env.Home, ".aws"), "deny"),
            new("keys", J(env.Home, ".gnupg"), "deny"),
            new("keys", J(env.AppData, "gnupg"), "deny"),
            new("browsers", J(env.LocalAppData, @"Google\Chrome\User Data"), "deny"),
            new("browsers", J(env.LocalAppData, @"Microsoft\Edge\User Data"), "deny"),
            new("browsers", J(env.AppData, @"Mozilla\Firefox"), "deny"),
            new("credentials", J(env.AppData, @"Microsoft\Credentials"), "deny"),
            new("credentials", J(env.LocalAppData, @"Microsoft\Credentials"), "deny"),
            new("credentials", J(env.AppData, @"Microsoft\Protect"), "deny"),
            new("startup", J(env.AppData, @"Microsoft\Windows\Start Menu\Programs\Startup"), "deny"),
            new("startup", J(env.ProgramData, @"Microsoft\Windows\Start Menu\Programs\StartUp"), "deny"),
            new("powershell_profiles", J(env.Documents, "WindowsPowerShell"), "deny"),
            new("powershell_profiles", J(env.Documents, "PowerShell"), "deny"),
            new("system", WinPath.Collapse(env.Windows), "ask"),
            new("system", drive + @"\Program Files", "ask"),
            new("system", drive + @"\Program Files (x86)", "ask"),
            new("system", WinPath.Collapse(env.ProgramData), "ask"),
            new("appdata", J(env.Home, "AppData"), "ask"),
            new("roots", WinPath.Collapse(env.Home), "ask", ExactOnly: true),
        ];
    }

    /// <summary>A path's real place, links followed; the path itself when that fails.</summary>
    public string Real(string full)
    {
        try
        {
            return WinPath.Collapse(_resolve(full));
        }
        catch (Exception)
        {
            return full;
        }
    }

    /// <summary>
    /// The verdict for one effect on a full path (already through <see cref="Real"/>).
    /// <paramref name="children"/>: the effect is on what is below the folder, not the folder
    /// itself (a wildcard, <c>Get-ChildItem x | Remove-Item</c>).
    /// </summary>
    public (Verdict Verdict, string Rule, WorkFolder? Folder, string? Protected) Judge(
        string path, EffectKind kind, bool children, PermissionProfile profile, IReadOnlyList<(WorkFolder Folder, string Path)> workFolders)
    {
        var shell = profile.Level("shell");
        var changes = kind != EffectKind.Read;
        // A delete (a move's source, a recursive delete) takes what is below it along.
        var takesBelow = kind is EffectKind.Delete;

        // 1. The hard floor, on every profile.
        foreach (var p in _protected.Where(p => p.Level == "hard"))
        {
            if (Touches(p, path, takesBelow))
            {
                return (Verdict.Deny, $"Anemo Desktop's own folder {p.Path}: never touched by an agent", null, "hard");
            }
        }

        if (shell == "deny")
        {
            return (Verdict.Deny, "the shell is off in this computer's permission profile", null, null);
        }

        if (shell == "policy")
        {
            return (Verdict.Allow, "as the Agent Permissions say (Trusted (legacy))", null, null);
        }

        var unrestricted = shell == "allow";
        if (!unrestricted)
        {
            // 2. Deny-protected folders (switchable to ask in Anemo), reads included: keys, browser profiles, …
            foreach (var p in _protected.Where(p => p.Level == "deny"))
            {
                if (Touches(p, path, takesBelow))
                {
                    var level = profile.Protected.TryGetValue(p.Key, out var set) ? set : "deny";
                    return level == "ask"
                        ? (Verdict.Ask, $"the protected folder {p.Path}", null, "deny")
                        : (Verdict.Deny, $"the protected folder {p.Path}: refused", null, "deny");
                }
            }

            // 3. Ask-protected folders: reading is fine, changing asks; only Once covers them (§6.2).
            // A work folder set up inside one (%TEMP% is in AppData) is the user's choice and holds
            // for what is inside it; a delete of the protected folder itself, or of more, still asks.
            if (changes)
            {
                var inWork = Holder(path, kind, children, workFolders);
                foreach (var p in _protected.Where(p => p.Level == "ask"))
                {
                    if (inWork.Folder is not null && WinPath.InsideOrSame(Real(p.Path), inWork.Path))
                    {
                        continue;
                    }

                    if (Touches(p, path, takesBelow))
                    {
                        return (Verdict.Ask, $"the protected folder {p.Path}", null, "ask");
                    }
                }

                if (WinPath.IsDriveRoot(path))
                {
                    return (Verdict.Ask, $"the root of the drive {path[..2]}", null, "ask");
                }
            }
        }

        if (!changes)
        {
            return (Verdict.Allow, "reads only", null, null);
        }

        if (unrestricted)
        {
            return (Verdict.Allow, "Unrestricted: the whole computer is a work folder", null, null);
        }

        if (shell == "ask")
        {
            return (Verdict.Ask, "this computer's permission profile asks before every command", null, null);
        }

        // 4. Work folders: the deepest that holds the path. Deleting the work folder itself asks.
        var holder = Holder(path, kind, children, workFolders);
        if (holder.Folder is not null)
        {
            var verb = kind switch { EffectKind.Delete => "delete", EffectKind.Run => "runs", _ => "writes" };
            return (Verdict.Allow, $"{verb} inside work folder {holder.Folder.Path}", holder.Folder, null);
        }

        if (kind == EffectKind.Delete && workFolders.Any(w => WinPath.Same(w.Path, path)))
        {
            return (Verdict.Ask, $"deletes the work folder {path} itself", null, null);
        }

        var what = kind switch { EffectKind.Delete => "deletes", EffectKind.Run => "runs a program in", _ => "writes" };
        return (Verdict.Ask, $"{what} {path}, outside the work folders (read-only there)", null, null);
    }

    private static (WorkFolder? Folder, string Path) Holder(
        string path, EffectKind kind, bool children, IReadOnlyList<(WorkFolder Folder, string Path)> workFolders) =>
        workFolders
            .Where(w => children ? WinPath.InsideOrSame(w.Path, path) : WinPath.Inside(w.Path, path) || (kind != EffectKind.Delete && WinPath.Same(w.Path, path)))
            .OrderByDescending(w => w.Path.Length)
            .Select(w => ((WorkFolder?)w.Folder, w.Path))
            .FirstOrDefault();

    /// <summary>
    /// Whether a click in an approval may make <paramref name="folder"/> a work folder or grant
    /// it for an hour (§6.2): never a drive's root, never inside a protected folder, and never a
    /// folder that holds an ask-protected one (the user folder, Windows, AppData), so a click
    /// can't open those up by accident. Deny-protected folders inside stay refused anyway.
    /// </summary>
    public bool Grantable(string folder)
    {
        if (WinPath.IsDriveRoot(folder))
        {
            return false;
        }

        foreach (var p in _protected)
        {
            var real = Real(p.Path);
            if (WinPath.InsideOrSame(real, folder) && !(p.ExactOnly && !WinPath.Same(real, folder)))
            {
                return false;
            }

            if (p.Level is "ask" && WinPath.Inside(folder, real))
            {
                return false;
            }
        }

        return true;
    }

    private bool Touches(ProtectedFolder p, string path, bool takesBelow)
    {
        var folder = Real(p.Path);
        if (WinPath.Same(folder, path))
        {
            return true;
        }

        if (p.ExactOnly)
        {
            return false;
        }

        return WinPath.Inside(folder, path) || (takesBelow && WinPath.Inside(path, folder));
    }
}
