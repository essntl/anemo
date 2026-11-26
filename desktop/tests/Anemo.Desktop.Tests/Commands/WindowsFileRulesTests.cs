using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Anemo.Desktop.Core.Commands;
using Anemo.Desktop.Core.Files;
using Anemo.Desktop.Core.Protocol;

namespace Anemo.Desktop.Tests.Commands;

/// <summary>A test that only means something on Windows; skipped elsewhere (CI runs Linux).</summary>
public sealed class WindowsFactAttribute : FactAttribute
{
    public WindowsFactAttribute()
    {
        if (!OperatingSystem.IsWindows())
        {
            Skip = "Needs Windows (see desktop/MANUAL-TESTS.md, device files).";
        }
    }
}

/// <inheritdoc cref="WindowsFactAttribute"/>
public sealed class WindowsTheoryAttribute : TheoryAttribute
{
    public WindowsTheoryAttribute()
    {
        if (!OperatingSystem.IsWindows())
        {
            Skip = "Needs Windows (see desktop/MANUAL-TESTS.md, device files).";
        }
    }
}

/// <summary>
/// The Windows-only parts of the folder rule (device-contracts.md §8.2): network, device and
/// stream paths, names compared without case, 8.3 short names, junctions, and the Mark of the
/// Web on a written file. Real files in a temporary home folder.
/// </summary>
public sealed class WindowsFileRulesTests : IDisposable
{
    private readonly ProcessorFixture _f = new();

    public WindowsFileRulesTests()
    {
        _f.Settings = _f.Settings with { ShareFiles = true };
        Directory.CreateDirectory(InHome("Documents"));
        Directory.CreateDirectory(InHome("AppData", "Roaming"));
        File.WriteAllText(InHome("Documents", "a.txt"), "a");
        File.WriteAllText(InHome("AppData", "Roaming", "secret.txt"), "s");
    }

    public void Dispose() => _f.Dispose();

    private string InHome(params string[] parts) => Path.Combine([_f.Home, .. parts]);

    private static string Sha(byte[] data) => Convert.ToHexString(SHA256.HashData(data)).ToLowerInvariant();

    private Task<JsonObject> Ok(string action, JsonObject fields) => _f.Ok(action, fields, ProcessorFixture.Trusted);

    private Task<CommandOutcome> Fails(string action, JsonObject fields, string code) =>
        _f.Fails(action, fields, code, ProcessorFixture.Trusted);

    /// <summary>The path with the temporary home folder's drive and folders put in for <c>{home}</c>.</summary>
    private string Expand(string pattern) =>
        pattern.Replace("{home}", _f.Home, StringComparison.Ordinal);

    [WindowsTheory]
    [InlineData(@"\\server\share\a.txt")]
    [InlineData(@"//server/share/a.txt")]
    [InlineData(@"\\localhost\C$\Users\a.txt")]
    [InlineData(@"\\?\{home}\Documents\a.txt")]
    [InlineData(@"\\?\UNC\server\share\a.txt")]
    [InlineData(@"\\.\{home}\Documents\a.txt")]
    [InlineData(@"\\.\PhysicalDrive0")]
    [InlineData(@"{home}\Documents\a.txt:secret")]
    [InlineData(@"{home}\Documents\a.txt::$DATA")]
    [InlineData(@"{home}\Documents\a.txt:Zone.Identifier:$DATA")]
    public async Task Network_device_and_stream_paths_are_refused(string pattern)
    {
        var path = Expand(pattern);
        await Fails("file_stat", new JsonObject { ["path"] = path }, ResultCodes.Refused);
        await Fails("file_write_begin", new JsonObject { ["path"] = path, ["size"] = 1, ["sha256"] = Sha([1]) }, ResultCodes.Refused);
    }

    [WindowsTheory]
    [InlineData(@"{home}\appdata\Roaming\secret.txt")]
    [InlineData(@"{home}\APPDATA\roaming\secret.txt")]
    [InlineData(@"{home}/AppData/Roaming/secret.txt")]
    [InlineData(@"{home}\documents\windowspowershell\profile.ps1")]
    [InlineData(@"{home}\DOCUMENTS\PowerShell\profile.ps1")]
    public async Task Protected_folders_are_found_whatever_the_case_or_separator(string pattern)
    {
        var path = Expand(pattern);
        await Fails("file_stat", new JsonObject { ["path"] = path }, ResultCodes.Refused);
        await Fails("file_write_begin", new JsonObject { ["path"] = path, ["size"] = 1, ["sha256"] = Sha([1]) }, ResultCodes.Refused);
    }

    [WindowsTheory]
    [InlineData(@"{home}\AppData.\Roaming\secret.txt")]
    [InlineData(@"{home}\AppData \Roaming\secret.txt")]
    [InlineData(@"{home}\AppData")]
    [InlineData(@"{home}\AppData.")]
    [InlineData(@"{home}\AppData ")]
    public async Task Trailing_dots_and_spaces_never_reach_a_protected_folder(string pattern)
    {
        // Windows drops a trailing dot or space from the last name; inside a path such a name is a
        // different (missing) folder. Either way the file in AppData is never read.
        var outcome = await _f.Run("file_stat", new JsonObject { ["path"] = Expand(pattern) }, ProcessorFixture.Trusted);
        Assert.False(outcome.Ok);
    }

    [WindowsFact]
    public async Task An_8dot3_short_name_is_taken_as_its_long_name()
    {
        // WindowsPowerShell is longer than 8 letters, so a drive with 8.3 names gives it WINDOW~1.
        var profiles = Directory.CreateDirectory(InHome("Documents", "WindowsPowerShell")).FullName;
        File.WriteAllText(Path.Combine(profiles, "profile.ps1"), "# mine");
        var shortProfiles = ShortPath(profiles);
        if (!Path.GetFileName(shortProfiles).Contains('~'))
        {
            return; // 8.3 names are switched off on this drive: there is no other name to check.
        }

        await Fails("file_stat", new JsonObject { ["path"] = Path.Combine(shortProfiles, "profile.ps1") }, ResultCodes.Refused);
        await Fails("file_write_begin", new JsonObject { ["path"] = Path.Combine(shortProfiles, "new.ps1"), ["size"] = 1, ["sha256"] = Sha([1]) }, ResultCodes.Refused);
        Assert.False(File.Exists(Path.Combine(profiles, "new.ps1")));

        // An allowed file by its short name is the long one.
        var rules = _f.Files.Rules();
        var notes = Directory.CreateDirectory(InHome("Documents", "Long folder name")).FullName;
        File.WriteAllText(Path.Combine(notes, "b.txt"), "b");
        Assert.Equal(Path.Combine(notes, "b.txt"), rules.Check(Path.Combine(ShortPath(notes), "b.txt")));
    }

    [WindowsFact]
    public async Task A_junction_out_of_the_allowed_folder_or_into_appdata_is_followed_before_the_check()
    {
        var secret = Path.Combine(Path.GetDirectoryName(_f.Home)!, "secret");
        Directory.CreateDirectory(secret);
        File.WriteAllText(Path.Combine(secret, "s.txt"), "s");
        Junction(InHome("Documents", "out"), secret);
        Junction(InHome("Documents", "roaming"), InHome("AppData", "Roaming"));

        await Fails("file_stat", new JsonObject { ["path"] = InHome("Documents", "out", "s.txt") }, ResultCodes.Refused);
        await Fails("file_write_begin", new JsonObject { ["path"] = InHome("Documents", "out", "new.txt"), ["size"] = 1, ["sha256"] = Sha([1]) }, ResultCodes.Refused);
        await Fails("file_stat", new JsonObject { ["path"] = InHome("Documents", "roaming", "secret.txt") }, ResultCodes.Refused);
        await Fails("file_write_begin", new JsonObject { ["path"] = InHome("Documents", "roaming", "new.txt"), ["size"] = 1, ["sha256"] = Sha([1]) }, ResultCodes.Refused);
        Assert.False(File.Exists(Path.Combine(secret, "new.txt")));
        Assert.False(File.Exists(InHome("AppData", "Roaming", "new.txt")));

        // Removed here: deleting the home folder recursively stops at a junction.
        Directory.Delete(InHome("Documents", "out"));
        Directory.Delete(InHome("Documents", "roaming"));
    }

    [WindowsFact]
    public async Task A_written_file_is_marked_as_coming_from_the_internet()
    {
        var path = InHome("Documents", "tool.ps1");
        var data = Encoding.UTF8.GetBytes("Write-Output hi");
        var transfer = (string)(await Ok("file_write_begin", new JsonObject { ["path"] = path, ["size"] = data.Length, ["sha256"] = Sha(data) }))["transfer"]!;
        await Ok("file_write_chunk", new JsonObject { ["transfer"] = transfer, ["offset"] = 0, ["data"] = Convert.ToBase64String(data), ["sha256"] = Sha(data) });
        await Ok("file_write_end", new JsonObject { ["transfer"] = transfer });

        Assert.Equal(data, File.ReadAllBytes(path));
        Assert.Equal(DeviceFiles.ZoneIdentifier, File.ReadAllText(path + ":Zone.Identifier"));
    }

    private static void Junction(string link, string target)
    {
        using var mklink = Process.Start(new ProcessStartInfo("cmd.exe", $"/c mklink /J \"{link}\" \"{target}\"")
        {
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        })!;
        mklink.WaitForExit();
        Assert.Equal(0, mklink.ExitCode);
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "GetShortPathNameW")]
    private static extern uint GetShortPathName(string longPath, StringBuilder shortPath, uint size);

    private static string ShortPath(string path)
    {
        var buffer = new StringBuilder(1024);
        return GetShortPathName(path, buffer, (uint)buffer.Capacity) > 0 ? buffer.ToString() : path;
    }
}
