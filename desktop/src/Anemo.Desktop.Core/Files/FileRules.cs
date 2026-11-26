using Anemo.Desktop.Core.CodeJobs;
using Anemo.Desktop.Core.Commands;
using Anemo.Desktop.Core.Platform;

namespace Anemo.Desktop.Core.Files;

/// <summary>
/// Which files Anemo may read and write on this computer (device-contracts.md §8.2,
/// docs/specs/22-device-files.md). A path must be a full path; with every link and junction on
/// the way followed it must be inside one of the allowed folders (Settings, else the user's
/// home folder), and below that folder no part of it may be hidden (a name starting with a
/// dot: <c>.ssh</c>, <c>.aws</c>, <c>.config</c>, <c>.git</c>, the shell's start files, …). Never
/// the home folder's system folders (<c>AppData</c> on Windows, <c>Library</c> on macOS: browser
/// profiles, keychains, start-up items), PowerShell's profile folders, the Startup folders, or
/// Anemo Desktop's own data folder (its settings and token), whatever Settings lists. A write
/// is also refused for the file types the platform never writes (shortcuts, <c>desktop.ini</c>).
/// </summary>
public sealed class FileRules
{
    public const int MaxPathLength = 1000;

    /// <summary>How many links in a row are followed before a path counts as a loop.</summary>
    private const int MaxLinkHops = 40;

    private readonly IReadOnlyList<string> _roots;
    private readonly IReadOnlyList<string> _protected;
    private readonly IReadOnlyList<string> _unwritten;
    private readonly string? _ownData;

    /// <param name="roots">The allowed folders (full paths); none means the home folder.</param>
    /// <param name="home">The user's home folder.</param>
    /// <param name="platform">Which folders below the home folder and which file types are protected.</param>
    /// <param name="ownData">Anemo Desktop's own data folder (settings, token, logs).</param>
    /// <param name="systemFolders">
    /// More folders never used, as full paths: those of <see cref="SystemFolders"/> (the Startup
    /// folders, PowerShell's folders below a Documents folder that was moved).
    /// </param>
    public FileRules(IReadOnlyList<string>? roots, string home, DesktopPlatform platform, string? ownData, IReadOnlyList<string>? systemFolders = null)
    {
        _roots = roots is { Count: > 0 } ? roots : [home];
        _protected = [.. platform.ProtectedHomeFolders.Select(name => Path.GetFullPath(Path.Combine(home, name))), .. systemFolders ?? []];
        _unwritten = platform.UnwrittenFileTypes;
        _ownData = ownData;
    }

    /// <summary>
    /// The protected folders that aren't at a fixed place below the home folder, as this
    /// computer has them: the user's and everyone's Startup folder, and PowerShell's profile
    /// folders below the system's Documents folder (which may have been moved to OneDrive or
    /// another drive). Empty off Windows.
    /// </summary>
    public static IReadOnlyList<string> SystemFolders(DesktopPlatform platform)
    {
        if (!OperatingSystem.IsWindows() || platform.IsMac)
        {
            return [];
        }

        var folders = new List<string>
        {
            Environment.GetFolderPath(Environment.SpecialFolder.Startup),
            Environment.GetFolderPath(Environment.SpecialFolder.CommonStartup),
        };
        var documents = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
        if (documents.Length > 0)
        {
            folders.AddRange(platform.ProtectedDocumentsFolders.Select(name => Path.Combine(documents, name)));
        }

        return folders.Where(folder => folder.Length > 0).ToList();
    }

    /// <summary>The allowed folders, as Settings has them (for the agent's error sentence).</summary>
    public IReadOnlyList<string> Roots => _roots;

    /// <summary>
    /// The path with its links followed, when Anemo may use it. Throws a
    /// <see cref="CommandException"/> otherwise: <c>failed</c> for a path that isn't one,
    /// <c>refused</c> for one outside the rules. The file need not exist (a write's target).
    /// </summary>
    public string Check(string path)
    {
        if (path.Length == 0 || path.Length > MaxPathLength || path.Any(char.IsControl))
        {
            throw CommandException.Failed("The path must be a full path of at most 1000 characters.");
        }

        if (!Path.IsPathFullyQualified(path))
        {
            throw CommandException.Failed("The path must be a full path on this computer.");
        }

        if (OperatingSystem.IsWindows() && (path.StartsWith(@"\\", StringComparison.Ordinal) || path.StartsWith("//", StringComparison.Ordinal)
            || path.IndexOf(':', 2) >= 0))
        {
            // Network shares and \\?\ device paths, and NTFS alternate data streams (file.txt:secret).
            throw CommandException.Refused("Anemo Desktop only copies files on this computer's own drives, without : in the name.");
        }

        var parts = path.Split(['/', '\\'], StringSplitOptions.RemoveEmptyEntries);
        if (parts.Any(p => p is "." or ".."))
        {
            throw CommandException.Failed("The path must not hold . or .. parts.");
        }

        // An 8.3 short name (APPDAT~1) needs no check of its own: on Windows Path.GetFullPath
        // (in Resolve) gives an existing one's long name, so the rules below see AppData.
        var resolved = Resolve(path);
        var root = _roots.Select(Resolve).FirstOrDefault(r => FolderLinks.IsInside(r, resolved));
        if (root is null)
        {
            throw CommandException.Refused(
                $"That is outside the folders Anemo may use on this computer ({string.Join("; ", _roots)}). The user can add folders in Anemo Desktop's Settings.");
        }

        var below = resolved[(Path.TrimEndingDirectorySeparator(root).Length + 1)..]
            .Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries);
        if (below.Any(p => p.StartsWith('.')))
        {
            throw CommandException.Refused("Anemo Desktop doesn't copy hidden files or anything in hidden folders (names that start with a dot).");
        }

        if (_protected.Select(Resolve).Any(folder => Same(resolved, folder) || FolderLinks.IsInside(folder, resolved)))
        {
            throw CommandException.Refused(
                $"Anemo Desktop doesn't copy files in the system's own folders or in folders whose files run by themselves ({string.Join("; ", _protected)}).");
        }

        if (_ownData is not null && (Same(resolved, Resolve(_ownData)) || FolderLinks.IsInside(Resolve(_ownData), resolved)))
        {
            throw CommandException.Refused("That is Anemo Desktop's own folder, which Anemo doesn't read or write.");
        }

        return resolved;
    }

    /// <summary>
    /// <see cref="Check"/> for a file about to be written: also never one of the file types the
    /// platform doesn't write (<see cref="DesktopPlatform.UnwrittenFileTypes"/>: shortcuts,
    /// <c>desktop.ini</c>), wherever it would go.
    /// </summary>
    public string CheckWrite(string path)
    {
        var resolved = Check(path);
        var name = Path.GetFileName(resolved);
        var unwritten = _unwritten.Any(type => type.StartsWith('.')
            ? name.EndsWith(type, StringComparison.OrdinalIgnoreCase)
            : string.Equals(name, type, StringComparison.OrdinalIgnoreCase));
        if (unwritten)
        {
            throw CommandException.Refused(
                $"Anemo Desktop doesn't write shortcuts or folder settings files ({string.Join(", ", _unwritten)}): the file browser acts on them just by showing the folder. Zip it, or give it another name.");
        }

        return resolved;
    }

    /// <summary>The full path with every link on the way followed, again until nothing changes (a link's target may itself be below a link).</summary>
    public static string Resolve(string path)
    {
        var current = Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));
        for (var hop = 0; hop < MaxLinkHops; hop++)
        {
            var next = Path.TrimEndingDirectorySeparator(FolderLinks.Resolved(current));
            if (string.Equals(next, current, StringComparison.Ordinal))
            {
                return current;
            }

            current = next;
        }

        throw CommandException.Failed("The path goes through too many links.");
    }

    private static bool Same(string a, string b) =>
        string.Equals(Path.TrimEndingDirectorySeparator(a), Path.TrimEndingDirectorySeparator(b),
            OperatingSystem.IsWindows() || OperatingSystem.IsMacOS() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);
}
