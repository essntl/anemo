using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Anemo.Desktop.Core.Commands;
using Anemo.Desktop.Core.Files;
using Anemo.Desktop.Core.Platform;
using Anemo.Desktop.Core.Protocol;
using Anemo.Desktop.Core.Storage;

namespace Anemo.Desktop.Tests.Commands;

/// <summary>
/// The file actions of device-contracts.md §8 (1.7.0): who may use them, which folders, the
/// chunked reads and writes with their hashes, the temporary file and the overwrite rule.
/// Real files in a temporary home folder.
/// </summary>
public sealed class FileTests : IDisposable
{
    private readonly ProcessorFixture _f = new();

    public FileTests()
    {
        _f.Settings = _f.Settings with { ShareFiles = true };
        Directory.CreateDirectory(Path.Combine(_f.Home, "Documents"));
    }

    public void Dispose() => _f.Dispose();

    private string InHome(params string[] parts) => Path.Combine([_f.Home, .. parts]);

    private static string Sha(byte[] data) => Convert.ToHexString(SHA256.HashData(data)).ToLowerInvariant();

    private static byte[] Blob(int size) => Enumerable.Range(0, size).Select(i => (byte)((i * 31) + 7)).ToArray();

    private Task<JsonObject> Ok(string action, JsonObject fields) => _f.Ok(action, fields, ProcessorFixture.Trusted);

    private Task<CommandOutcome> Fails(string action, JsonObject fields, string code) =>
        _f.Fails(action, fields, code, ProcessorFixture.Trusted);

    private Task<JsonObject> Begin(string path, byte[] data, bool overwrite = false) =>
        Ok("file_write_begin", new JsonObject { ["path"] = path, ["size"] = data.Length, ["sha256"] = Sha(data), ["overwrite"] = overwrite });

    private static JsonObject Chunk(string transfer, long offset, byte[] data) => new()
    {
        ["transfer"] = transfer,
        ["offset"] = offset,
        ["data"] = Convert.ToBase64String(data),
        ["sha256"] = Sha(data),
    };

    private string[] PartFiles() => Directory.GetFiles(_f.Home, "*.part", SearchOption.AllDirectories);

    // -- who may ----------------------------------------------------------------------------

    [Fact]
    public async Task Only_a_trusted_device_with_the_switch_on_and_not_paused()
    {
        var path = InHome("Documents", "a.txt");
        File.WriteAllText(path, "hello");
        var stat = new JsonObject { ["path"] = path };

        var watched = await _f.Fails("file_stat", stat, ResultCodes.Refused, ProcessorFixture.Watched);
        Assert.Contains("trusted", watched.Error);

        _f.Settings = _f.Settings with { ShareFiles = false };
        var off = await Fails("file_stat", stat, ResultCodes.Refused);
        Assert.Contains("Let Anemo read and write files", off.Error);

        _f.Settings = _f.Settings with { ShareFiles = true };
        _f.Control.Stop();
        await Fails("file_stat", stat, ResultCodes.Refused);
        _f.Control.Resume();

        // "Allow control" isn't needed: copying files is its own switch.
        _f.Control.SetAllow(false);
        Assert.Equal("file", (string?)(await Ok("file_stat", stat))["kind"]);
        Assert.True(_f.Files.Offered(ProcessorFixture.Trusted));
        Assert.False(_f.Files.Offered(ProcessorFixture.Watched));
    }

    // -- which folders ----------------------------------------------------------------------

    [Fact]
    public async Task Only_inside_the_allowed_folders_and_never_hidden_or_system_folders()
    {
        Directory.CreateDirectory(InHome(".ssh"));
        File.WriteAllText(InHome(".ssh", "id_ed25519"), "key");
        Directory.CreateDirectory(InHome("AppData", "Roaming", "Microsoft"));
        File.WriteAllText(InHome("AppData", "Roaming", "Microsoft", "x"), "x");
        Directory.CreateDirectory(_f.DataFolder);
        File.WriteAllText(Path.Combine(_f.DataFolder, "settings.json"), "{}");
        var outside = Path.Combine(Path.GetDirectoryName(_f.Home)!, "elsewhere.txt");
        File.WriteAllText(outside, "x");

        foreach (var refused in new[]
        {
            InHome(".ssh", "id_ed25519"),
            InHome("Documents", ".git", "config"),
            InHome("AppData", "Roaming", "Microsoft", "x"),
            Path.Combine(_f.DataFolder, "settings.json"),
            outside,
        })
        {
            await Fails("file_stat", new JsonObject { ["path"] = refused }, ResultCodes.Refused);
        }

        foreach (var bad in new[] { "Documents/a.txt", InHome("Documents", "..", "..", "elsewhere.txt") })
        {
            await Fails("file_stat", new JsonObject { ["path"] = bad }, ResultCodes.Failed);
        }

        await Fails("file_stat", new JsonObject { ["path"] = InHome("Documents", "none.txt") }, ResultCodes.NotFound);
        Assert.Equal("folder", (string?)(await Ok("file_stat", new JsonObject { ["path"] = InHome("Documents") }))["kind"]);

        // Folders from Settings replace the home folder.
        var shared = Path.Combine(Path.GetDirectoryName(_f.Home)!, "Shared");
        Directory.CreateDirectory(shared);
        File.WriteAllText(Path.Combine(shared, "b.txt"), "b");
        File.WriteAllText(InHome("Documents", "a.txt"), "a");
        _f.Settings = _f.Settings with { FileFolders = [shared] };
        await Ok("file_stat", new JsonObject { ["path"] = Path.Combine(shared, "b.txt") });
        await Fails("file_stat", new JsonObject { ["path"] = InHome("Documents", "a.txt") }, ResultCodes.Refused);
    }

    [Fact]
    public async Task Never_powershell_profile_folders_whose_scripts_run_at_every_start()
    {
        foreach (var folder in new[] { "PowerShell", "WindowsPowerShell" })
        {
            Directory.CreateDirectory(InHome("Documents", folder));
            var profile = InHome("Documents", folder, "Microsoft.PowerShell_profile.ps1");
            File.WriteAllText(profile, "# mine");

            await Fails("file_stat", new JsonObject { ["path"] = profile }, ResultCodes.Refused);
            await Fails("file_write_begin", new JsonObject { ["path"] = InHome("Documents", folder, "profile.ps1"), ["size"] = 1, ["sha256"] = Sha([1]) }, ResultCodes.Refused);
            await Fails("file_write_begin", new JsonObject { ["path"] = InHome("Documents", folder, "Modules", "m", "m.psm1"), ["size"] = 1, ["sha256"] = Sha([1]) }, ResultCodes.Refused);
            Assert.False(File.Exists(InHome("Documents", folder, "profile.ps1")));
        }

        // A file next to them in Documents is fine.
        await Begin(InHome("Documents", "PowerShell notes.txt"), [1]);
    }

    [Fact]
    public void PowerShell_folders_below_a_moved_documents_folder_and_the_startup_folders_are_protected_too()
    {
        var oneDrive = Path.Combine(_f.Home, "OneDrive", "Documents");
        var startup = Path.Combine(_f.Home, "Start");
        var rules = new FileRules(null, _f.Home, DesktopPlatform.Windows, null,
            [Path.Combine(oneDrive, "WindowsPowerShell"), startup]);

        Assert.Throws<CommandException>(() => rules.CheckWrite(Path.Combine(oneDrive, "WindowsPowerShell", "profile.ps1")));
        Assert.Throws<CommandException>(() => rules.CheckWrite(Path.Combine(startup, "run.bat")));
        Assert.Equal(Path.Combine(oneDrive, "report.docx"), rules.CheckWrite(Path.Combine(oneDrive, "report.docx")));
    }

    [Theory]
    [InlineData("Chrome.lnk")]
    [InlineData("Bank.URL")]
    [InlineData("explorer.scf")]
    [InlineData("Music.library-ms")]
    [InlineData("x.searchConnector-ms")]
    [InlineData("x.settingcontent-ms")]
    [InlineData("desktop.ini")]
    public async Task Shortcuts_and_folder_settings_files_are_never_written_but_can_be_read(string name)
    {
        Directory.CreateDirectory(InHome("Desktop"));
        var path = InHome("Desktop", name);
        var refused = await Fails("file_write_begin", new JsonObject { ["path"] = path, ["size"] = 1, ["sha256"] = Sha([1]) }, ResultCodes.Refused);
        Assert.Contains("shortcuts", refused.Error);
        Assert.Empty(PartFiles());

        File.WriteAllText(path, "x");
        Assert.Equal("file", (string?)(await Ok("file_stat", new JsonObject { ["path"] = path }))["kind"]);
    }

    [Fact]
    public void A_mac_writes_any_file_type_finder_runs_nothing_for_showing_a_folder()
    {
        var rules = new FileRules(null, _f.Home, DesktopPlatform.MacOS(_f.Home), null);
        var path = InHome("Desktop", "a.lnk");
        Assert.Equal(path, rules.CheckWrite(path));
        Assert.Throws<CommandException>(() => rules.Check(InHome("Library", "LaunchAgents", "x.plist")));
        Assert.Throws<CommandException>(() => rules.Check(InHome(".zshrc")));
    }

    [Fact]
    public async Task A_link_out_of_the_allowed_folder_is_followed_before_the_check()
    {
        var secret = Path.Combine(Path.GetDirectoryName(_f.Home)!, "secret");
        Directory.CreateDirectory(secret);
        File.WriteAllText(Path.Combine(secret, "s.txt"), "s");
        try
        {
            Directory.CreateSymbolicLink(InHome("Documents", "link"), secret);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return; // Windows without the right to make links: CI (Linux, macOS) runs this.
        }

        await Fails("file_stat", new JsonObject { ["path"] = InHome("Documents", "link", "s.txt") }, ResultCodes.Refused);
        await Fails("file_write_begin", new JsonObject
        {
            ["path"] = InHome("Documents", "link", "new.txt"), ["size"] = 1, ["sha256"] = Sha([1]),
        }, ResultCodes.Refused);
        Assert.False(File.Exists(Path.Combine(secret, "new.txt")));
    }

    // -- reading ----------------------------------------------------------------------------

    [Fact]
    public async Task A_file_is_read_in_chunks_with_their_hashes()
    {
        var data = Blob(10_000);
        var path = InHome("Documents", "report.pdf");
        File.WriteAllBytes(path, data);

        var stat = await Ok("file_stat", new JsonObject { ["path"] = path, ["hash"] = true });
        Assert.Equal(10_000, (long)stat["size"]!);
        Assert.Equal(Sha(data), (string?)stat["sha256"]);
        Assert.Null((await Ok("file_stat", new JsonObject { ["path"] = path }))["sha256"]);

        var chunk = await Ok("file_read", new JsonObject { ["path"] = path, ["offset"] = 4000, ["length"] = 4000 });
        var bytes = Convert.FromBase64String((string)chunk["data"]!);
        Assert.Equal(data[4000..8000], bytes);
        Assert.Equal(Sha(bytes), (string?)chunk["sha256"]);
        var last = await Ok("file_read", new JsonObject { ["path"] = path, ["offset"] = 8000, ["length"] = 4000 });
        Assert.Equal(2000, Convert.FromBase64String((string)last["data"]!).Length);

        await Fails("file_read", new JsonObject { ["path"] = path, ["offset"] = 0, ["length"] = DeviceFiles.MaxChunkBytes + 1 }, ResultCodes.Failed);
    }

    // -- writing ----------------------------------------------------------------------------

    [Fact]
    public async Task A_write_goes_to_a_temporary_file_and_gets_its_name_only_at_the_end()
    {
        var data = Blob(5000);
        var path = InHome("Documents", "new", "data.bin"); // a missing folder is made
        var transfer = (string)(await Begin(path, data))["transfer"]!;
        await Ok("file_write_chunk", Chunk(transfer, 0, data[..3000]));
        Assert.False(File.Exists(path));
        Assert.Single(PartFiles());

        await Ok("file_write_chunk", Chunk(transfer, 3000, data[3000..]));
        var end = await Ok("file_write_end", new JsonObject { ["transfer"] = transfer });

        Assert.Equal(data, File.ReadAllBytes(path));
        Assert.Equal(Sha(data), (string?)end["sha256"]);
        Assert.False((bool)end["replaced"]!);
        Assert.Empty(PartFiles());
        Assert.Equal(0, _f.Files.OpenTransfers);
    }

    [Fact]
    public async Task An_existing_file_is_replaced_only_with_overwrite()
    {
        var path = InHome("Documents", "todo.md");
        File.WriteAllText(path, "mine");
        var data = Encoding.UTF8.GetBytes("theirs");

        var refused = await Fails("file_write_begin", new JsonObject { ["path"] = path, ["size"] = data.Length, ["sha256"] = Sha(data) }, ResultCodes.Exists);
        Assert.Contains("already there", refused.Error);

        var transfer = (string)(await Begin(path, data, overwrite: true))["transfer"]!;
        await Ok("file_write_chunk", Chunk(transfer, 0, data));
        Assert.Equal("mine", File.ReadAllText(path)); // still the old one until the end
        var end = await Ok("file_write_end", new JsonObject { ["transfer"] = transfer });
        Assert.True((bool)end["replaced"]!);
        Assert.Equal("theirs", File.ReadAllText(path));
    }

    [Fact]
    public async Task A_file_that_appears_meanwhile_is_left_alone()
    {
        var path = InHome("Documents", "race.txt");
        var data = Encoding.UTF8.GetBytes("ours");
        var transfer = (string)(await Begin(path, data))["transfer"]!;
        await Ok("file_write_chunk", Chunk(transfer, 0, data));
        File.WriteAllText(path, "someone else's");

        await Fails("file_write_end", new JsonObject { ["transfer"] = transfer }, ResultCodes.Exists);
        Assert.Equal("someone else's", File.ReadAllText(path));
        Assert.Empty(PartFiles());
    }

    [Fact]
    public async Task A_bad_chunk_or_a_wrong_whole_hash_stops_the_copy_and_removes_the_temporary_file()
    {
        var path = InHome("Documents", "x.bin");
        var data = Blob(100);
        var transfer = (string)(await Begin(path, data))["transfer"]!;
        var bad = Chunk(transfer, 0, data);
        bad["sha256"] = Sha([1, 2, 3]);
        await Fails("file_write_chunk", bad, ResultCodes.Failed);
        Assert.Empty(PartFiles());
        await Fails("file_write_chunk", Chunk(transfer, 0, data), ResultCodes.Failed); // that copy is gone

        // Every chunk right, but the file isn't what the begin announced.
        var other = (string)(await Ok("file_write_begin", new JsonObject { ["path"] = path, ["size"] = 100, ["sha256"] = Sha(Blob(99)) }))["transfer"]!;
        await Ok("file_write_chunk", Chunk(other, 0, data));
        await Fails("file_write_end", new JsonObject { ["transfer"] = other }, ResultCodes.Failed);
        Assert.False(File.Exists(path));
        Assert.Empty(PartFiles());

        // Too few bytes, or a chunk out of order.
        var third = (string)(await Begin(path, data))["transfer"]!;
        await Fails("file_write_chunk", Chunk(third, 50, data[50..]), ResultCodes.Failed);
        var fourth = (string)(await Begin(path, data))["transfer"]!;
        await Ok("file_write_chunk", Chunk(fourth, 0, data[..50]));
        await Fails("file_write_end", new JsonObject { ["transfer"] = fourth }, ResultCodes.Failed);
        Assert.False(File.Exists(path));
        Assert.Empty(PartFiles());
    }

    [Fact]
    public async Task An_abort_or_a_minute_without_a_chunk_drops_the_copy()
    {
        var data = Blob(10);
        var first = (string)(await Begin(InHome("Documents", "a.bin"), data))["transfer"]!;
        await Ok("file_write_abort", new JsonObject { ["transfer"] = first });
        Assert.Empty(PartFiles());

        var second = (string)(await Begin(InHome("Documents", "b.bin"), data))["transfer"]!;
        _f.Time.Now += DeviceFiles.TransferIdle + TimeSpan.FromSeconds(1);
        var gone = await Fails("file_write_chunk", Chunk(second, 0, data), ResultCodes.Failed);
        Assert.Contains("isn't open", gone.Error);
        Assert.Empty(PartFiles());
        Assert.False(File.Exists(InHome("Documents", "b.bin")));
    }

    [Fact]
    public async Task At_most_a_few_writes_are_open_at_once()
    {
        var data = Blob(1);
        for (var i = 0; i < DeviceFiles.MaxTransfers; i++)
        {
            await Begin(InHome("Documents", $"{i}.bin"), data);
        }

        await Fails("file_write_begin", new JsonObject { ["path"] = InHome("Documents", "more.bin"), ["size"] = 1, ["sha256"] = Sha(data) }, ResultCodes.Unavailable);
    }

    [Fact]
    public async Task The_log_has_the_path_and_sizes_but_never_the_data()
    {
        var path = InHome("Documents", "log.txt");
        var data = Encoding.UTF8.GetBytes("SECRET-CONTENT");
        var transfer = (string)(await Begin(path, data))["transfer"]!;
        await Ok("file_write_chunk", Chunk(transfer, 0, data));
        await Ok("file_write_end", new JsonObject { ["transfer"] = transfer });

        var log = string.Join("\n", Directory.GetFiles(_f.LogFolder, "*.jsonl", SearchOption.AllDirectories).Select(File.ReadAllText));
        Assert.Contains("file_write_chunk", log);
        Assert.Contains("log.txt", log);
        Assert.DoesNotContain(Convert.ToBase64String(data), log);
        Assert.DoesNotContain("SECRET-CONTENT", log);
    }

    // -- settings ---------------------------------------------------------------------------

    [Fact]
    public void Settings_take_full_folder_paths_separated_by_semicolons()
    {
        var a = Path.Combine(_f.Home, "A");
        var b = Path.Combine(_f.Home, "B");
        var draft = SettingsDraft.From(new DesktopSettings()) with
        {
            Address = "https://anemo.example.com",
            ShareFiles = true,
            FileFolders = $" {a} ;{b}; ",
        };
        var check = draft.Check(new DesktopSettings());
        Assert.True(check.Ok);
        Assert.True(check.Settings!.ShareFiles);
        Assert.Equal([a, b], check.Settings.FileFolders);
        Assert.Equal($"{a}; {b}", SettingsDraft.From(check.Settings).FileFolders);

        var empty = (draft with { FileFolders = "  " }).Check(new DesktopSettings());
        Assert.Null(empty.Settings!.FileFolders);

        var relative = (draft with { FileFolders = "Documents" }).Check(new DesktopSettings());
        Assert.Equal(SettingsField.FileFolders, relative.Problem!.Field);
    }
}
