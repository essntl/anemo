namespace Anemo.Desktop.Core.Permissions;

/// <summary>
/// Windows paths as plain strings (docs/specs/25-device-permission-profiles.md §4.4), the same on
/// every system the tests run on: <c>/</c> becomes <c>\</c>, <c>.</c> and <c>..</c> are collapsed,
/// names lose the trailing dots and spaces Windows ignores, and comparisons ignore case. Links
/// and junctions are followed by the caller (<see cref="PathZones"/>), on the result of this.
/// </summary>
public static class WinPath
{
    /// <summary>What a path in a command turned out to be.</summary>
    public enum Kind
    {
        /// <summary>A full path on a drive of this computer: <c>C:\dev\x</c>.</summary>
        Local,

        /// <summary>A network share or device path (<c>\\server\share</c>, <c>\\?\C:\x</c>): always asks.</summary>
        Unc,

        /// <summary>Another PowerShell provider: the registry, <c>Env:</c>, <c>Function:</c>, …</summary>
        Provider,

        /// <summary>Relative to something unknown (<c>C:foo</c>, or a working folder that isn't known).</summary>
        Unknown,
    }

    private static readonly string[] FileSystemPrefixes =
    [
        @"Microsoft.PowerShell.Core\FileSystem::",
        "FileSystem::",
    ];

    /// <summary>
    /// The full path of <paramref name="path"/> written in a command run in <paramref name="cwd"/>
    /// (null: not known), with <paramref name="home"/> for <c>~</c>.
    /// </summary>
    public static (Kind Kind, string Path) Full(string path, string? cwd, string home)
    {
        var p = path.Trim().Replace('/', '\\');
        foreach (var prefix in FileSystemPrefixes)
        {
            if (p.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                p = p[prefix.Length..];
                break;
            }
        }

        if (p.StartsWith(@"\\", StringComparison.Ordinal))
        {
            return (Kind.Unc, p);
        }

        if (p.Contains("::", StringComparison.Ordinal))
        {
            return (Kind.Provider, p);
        }

        var colon = p.IndexOf(':');
        if (colon == 1 && char.IsAsciiLetter(p[0]))
        {
            if (p.Length == 2 || p[2] != '\\')
            {
                return (Kind.Unknown, p); // C: or C:foo: relative to that drive's own current folder
            }

            if (p.IndexOf(':', 2) >= 0)
            {
                return (Kind.Unknown, p); // an NTFS stream (file.txt:secret)
            }

            return (Kind.Local, Collapse(p));
        }

        if (colon > 1)
        {
            return (Kind.Provider, p); // HKLM:\…, Env:, Function:, Cert:, a drive with a longer name
        }

        if (p == "~" || p.StartsWith(@"~\", StringComparison.Ordinal))
        {
            return (Kind.Local, Collapse(home + p[1..]));
        }

        if (cwd is null)
        {
            return (Kind.Unknown, p);
        }

        if (p.StartsWith('\\'))
        {
            return (Kind.Local, Collapse(cwd[..2] + p)); // the root of the working folder's drive
        }

        return (Kind.Local, Collapse(cwd.TrimEnd('\\') + "\\" + p));
    }

    /// <summary><c>C:\a\.\b\..\c.\</c> → <c>C:\a\c</c>; never above the drive's root.</summary>
    public static string Collapse(string full)
    {
        var drive = char.ToUpperInvariant(full[0]) + ":";
        var parts = new List<string>();
        foreach (var raw in full[2..].Split('\\', StringSplitOptions.RemoveEmptyEntries))
        {
            if (raw == ".")
            {
                continue;
            }

            if (raw == "..")
            {
                if (parts.Count > 0)
                {
                    parts.RemoveAt(parts.Count - 1);
                }

                continue;
            }

            var name = raw.TrimEnd('.', ' ');
            if (name.Length == 0)
            {
                continue; // "..." and "  " are no names Windows keeps
            }

            parts.Add(name);
        }

        return parts.Count == 0 ? drive + "\\" : drive + "\\" + string.Join('\\', parts);
    }

    /// <summary><paramref name="child"/> is <paramref name="parent"/> or below it.</summary>
    public static bool InsideOrSame(string parent, string child) =>
        Same(parent, child) || Inside(parent, child);

    /// <summary><paramref name="child"/> is strictly below <paramref name="parent"/>.</summary>
    public static bool Inside(string parent, string child)
    {
        var p = parent.TrimEnd('\\') + "\\";
        return child.Length > p.Length && child.StartsWith(p, StringComparison.OrdinalIgnoreCase);
    }

    public static bool Same(string a, string b) =>
        string.Equals(a.TrimEnd('\\'), b.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);

    /// <summary>A drive's root: <c>C:\</c>.</summary>
    public static bool IsDriveRoot(string full) => full.Length <= 3 && full.Length >= 2 && full[1] == ':';

    /// <summary>The folder a path is in (<c>C:\a\b</c> → <c>C:\a</c>; a root stays itself).</summary>
    public static string Parent(string full)
    {
        if (IsDriveRoot(full))
        {
            return full;
        }

        var i = full.TrimEnd('\\').LastIndexOf('\\');
        return i <= 2 ? full[..2] + "\\" : full[..i];
    }

    /// <summary>The wildcards of PowerShell's <c>-Path</c>: <c>* ? [</c>.</summary>
    public static int WildcardAt(string path) => path.IndexOfAny(['*', '?', '[']);

    /// <summary>
    /// <c>%USERPROFILE%\Downloads</c> → <c>C:\Users\artem\Downloads</c> with <paramref name="env"/>'s
    /// folders; null when it names a variable this doesn't know.
    /// </summary>
    public static string? Expand(string path, PathEnvironment env)
    {
        var result = path;
        foreach (var (name, value) in env.Variables())
        {
            result = result.Replace("%" + name + "%", value, StringComparison.OrdinalIgnoreCase);
        }

        return result.Contains('%') ? null : result;
    }
}

/// <summary>
/// This computer's folders that paths in commands are expanded with: <c>$HOME</c>,
/// <c>$env:USERPROFILE</c>, <c>$env:TEMP</c>, <c>$env:TMP</c>, <c>$env:LOCALAPPDATA</c>,
/// <c>$env:APPDATA</c> (§4.4), plus those the protected folders need.
/// </summary>
public sealed record PathEnvironment(
    string Home,
    string Temp,
    string LocalAppData,
    string AppData,
    string ProgramData,
    string Windows,
    string Documents)
{
    /// <summary>This computer's (Windows) folders.</summary>
    public static PathEnvironment Current()
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        string Or(string value, string fallback) => string.IsNullOrEmpty(value) ? fallback : value;
        return new PathEnvironment(
            home,
            Path.TrimEndingDirectorySeparator(Or(Environment.GetEnvironmentVariable("TEMP") ?? "", Path.Combine(home, @"AppData\Local\Temp"))),
            Or(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), Path.Combine(home, @"AppData\Local")),
            Or(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), Path.Combine(home, @"AppData\Roaming")),
            Or(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), @"C:\ProgramData"),
            Or(Environment.GetFolderPath(Environment.SpecialFolder.Windows), @"C:\Windows"),
            Or(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), Path.Combine(home, "Documents")));
    }

    /// <summary>The variables of the <c>%NAME%</c> form a work folder may use.</summary>
    public IEnumerable<(string Name, string Value)> Variables()
    {
        yield return ("USERPROFILE", Home);
        yield return ("TEMP", Temp);
        yield return ("TMP", Temp);
        yield return ("LOCALAPPDATA", LocalAppData);
        yield return ("APPDATA", AppData);
        yield return ("PROGRAMDATA", ProgramData);
    }

    /// <summary>A PowerShell variable used as a path (<c>env:TEMP</c>, <c>HOME</c>), or null when it isn't one of §4.4's.</summary>
    public string? PowerShellVariable(string name) => name.ToLowerInvariant() switch
    {
        "home" or "env:userprofile" => Home,
        "env:temp" or "env:tmp" => Temp,
        "env:localappdata" => LocalAppData,
        "env:appdata" => AppData,
        _ => null,
    };
}
