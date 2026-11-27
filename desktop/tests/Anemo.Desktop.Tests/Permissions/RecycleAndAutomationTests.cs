using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using Anemo.Desktop.Core.Commands;
using Anemo.Desktop.Core.Permissions;
using Anemo.Desktop.Tests.Commands;

namespace Anemo.Desktop.Tests.Permissions;

/// <summary>Recycle Bin deletes (spec 25 §8) and automations on an Unrestricted computer (§9).</summary>
public sealed class RecycleAndAutomationTests : IClassFixture<AnalyserFixture>, IDisposable
{
    private readonly string _folder = Path.Combine(Path.GetTempPath(), "anemo-recycle-tests", Guid.NewGuid().ToString("N"));
    private readonly PermissionGuard _guard;
    private readonly ProcessorFixture _f;

    public RecycleAndAutomationTests(AnalyserFixture fixture)
    {
        _guard = new PermissionGuard(new PermissionStore(Path.Combine(_folder, "permissions.json")), fixture.Analyser, () => false);
        _f = new ProcessorFixture(permissions: _guard);
        _f.Settings = _f.Settings with { PowerShellEnabled = true, WorkFolder = @"C:\Users\artem\AnemoWork" };
    }

    public void Dispose()
    {
        _f.Dispose();
        if (Directory.Exists(_folder))
        {
            Directory.Delete(_folder, recursive: true);
        }
    }

    private static string Script(Core.Platform.ShellStart start) => Encoding.Unicode.GetString(Convert.FromBase64String(start.Arguments[^1]));

    private Task Sync(PermissionProfile profile) => _f.Ok("profile.sync", new JsonObject { ["profile"] = profile.ToJson() }, ProcessorFixture.Trusted);

    [Fact]
    public async Task Deletes_in_a_recycle_bin_work_folder_go_to_the_recycle_bin()
    {
        await Sync(AnalyserFixture.Scoped);
        var state = await _f.Ok("shell", new JsonObject { ["command"] = @"Remove-Item C:\Users\artem\Downloads\old.zip" }, ProcessorFixture.Trusted);
        Assert.Contains("SendToRecycleBin", Script(_f.Platform.Shell.Started[^1]));
        Assert.True((bool)state["recycled"]!);

        // C:\dev has no Recycle Bin: a permanent delete, and the result says so.
        state = await _f.Ok("shell", new JsonObject { ["command"] = @"Remove-Item C:\dev\x.log" }, ProcessorFixture.Trusted);
        Assert.DoesNotContain("SendToRecycleBin", Script(_f.Platform.Shell.Started[^1]));
        Assert.False((bool)state["recycled"]!);
    }

    [Fact]
    public async Task The_prelude_really_moves_a_file_to_the_recycle_bin()
    {
        if (!OperatingSystem.IsWindows())
        {
            return; // the Recycle Bin is Windows'
        }

        Directory.CreateDirectory(_folder);
        var file = Path.Combine(_folder, "to-recycle.txt");
        File.WriteAllText(file, "x");
        var script = RecyclePrelude.Script + $"Remove-Item -LiteralPath '{file}'";
        var info = new ProcessStartInfo(PowerShellParseHelper.Find()!) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true };
        foreach (var a in new[] { "-NoProfile", "-NonInteractive", "-EncodedCommand", Convert.ToBase64String(Encoding.Unicode.GetBytes(script)) })
        {
            info.ArgumentList.Add(a);
        }

        using var process = Process.Start(info)!;
        var errors = await process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        Assert.False(File.Exists(file), errors);
    }

    [Fact]
    public async Task An_automation_on_an_unrestricted_computer_works_as_scoped()
    {
        await Sync(AnalyserFixture.With("allow"));
        const string pictures = @"Remove-Item C:\Users\artem\Pictures\x.png";
        await _f.Ok("shell", new JsonObject { ["command"] = pictures }, ProcessorFixture.Trusted);
        var refused = await _f.Fails("shell", new JsonObject { ["command"] = pictures, ["automation"] = true }, ResultCodes.Refused, ProcessorFixture.Trusted);
        Assert.Contains("approval", refused.Error);
        var analysed = await _f.Ok("shell.analyze", new JsonObject { ["command"] = pictures, ["automation"] = true }, ProcessorFixture.Trusted);
        Assert.Equal("ask", (string?)analysed["verdict"]);

        // "Unrestricted for automations" on: as for everyone else.
        await Sync(AnalyserFixture.With("allow") with { Version = 8, AutomationsUnrestricted = true });
        await _f.Ok("shell", new JsonObject { ["command"] = pictures, ["automation"] = true }, ProcessorFixture.Trusted);
    }
}
