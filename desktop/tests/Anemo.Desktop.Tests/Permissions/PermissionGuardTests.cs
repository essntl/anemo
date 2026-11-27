using System.Text.Json.Nodes;
using Anemo.Desktop.Core.Commands;
using Anemo.Desktop.Core.Permissions;
using Anemo.Desktop.Core.Protocol;
using Anemo.Desktop.Tests.Commands;

namespace Anemo.Desktop.Tests.Permissions;

/// <summary>
/// The device's own enforcement (spec 25 §6.1, §10): <c>profile.sync</c>, <c>shell.analyze</c>, the
/// check before every <c>shell</c>, and the optional on-site confirmation of a loosening.
/// </summary>
public sealed class PermissionGuardTests : IClassFixture<AnalyserFixture>, IDisposable
{
    private readonly string _folder = Path.Combine(Path.GetTempPath(), "anemo-guard-tests", Guid.NewGuid().ToString("N"));
    private readonly PermissionGuard _guard;
    private readonly ProcessorFixture _f;
    private bool _confirm;

    public PermissionGuardTests(AnalyserFixture fixture)
    {
        _guard = new PermissionGuard(new PermissionStore(Path.Combine(_folder, "permissions.json")), fixture.Analyser, () => _confirm);
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

    private static JsonObject Sync(PermissionProfile profile) => new() { ["profile"] = profile.ToJson() };

    private static JsonObject Shell(string command, JsonObject? extra = null)
    {
        var fields = new JsonObject { ["command"] = command, ["timeout_s"] = 30 };
        foreach (var (key, value) in extra ?? new JsonObject())
        {
            fields[key] = value?.DeepClone();
        }

        return fields;
    }

    [Fact]
    public async Task A_synced_profile_is_kept_and_enforced()
    {
        var answer = await _f.Ok("profile.sync", Sync(AnalyserFixture.Scoped), ProcessorFixture.Trusted);
        Assert.True((bool)answer["applied"]!);
        Assert.Equal(7, (int)answer["version"]!);
        Assert.Equal(7, _guard.Version);
        // A copy that survives a restart, in the data folder.
        var again = new PermissionStore(Path.Combine(_folder, "permissions.json"));
        Assert.Equal("Scoped", again.Applied?.Name);
        // An older sync never replaces a newer copy.
        var older = await _f.Ok("profile.sync", Sync(AnalyserFixture.Scoped with { Version = 3 }), ProcessorFixture.Trusted);
        Assert.False((bool)older["applied"]!);
        Assert.Equal(7, _guard.Version);
    }

    [Fact]
    public async Task Shell_analyze_answers_with_the_verdict_and_rule()
    {
        await _f.Ok("profile.sync", Sync(AnalyserFixture.Scoped), ProcessorFixture.Trusted);
        var state = await _f.Ok("shell.analyze", new JsonObject { ["command"] = @"Remove-Item C:\dev\x.log" }, ProcessorFixture.Trusted);
        Assert.Equal("allow", (string?)state["verdict"]);
        Assert.Contains(@"work folder C:\dev", (string?)state["rule"]);
        Assert.Equal("delete", (string?)state["effects"]![0]!["kind"]);
        Assert.Equal(7, (int)state["profile_version"]!);
        Assert.Empty(_f.Platform.Shell.Started); // analysing never runs anything
    }

    [Fact]
    public async Task The_device_refuses_what_its_profile_denies_whatever_the_server_sent()
    {
        await _f.Ok("profile.sync", Sync(AnalyserFixture.Scoped), ProcessorFixture.Trusted);
        var refused = await _f.Fails(
            "shell",
            Shell(@"Remove-Item C:\Users\artem\.ssh\id_rsa", new JsonObject { ["approval"] = new JsonObject { ["id"] = "a1", ["scope"] = "once" }, ["profile_version"] = 7 }),
            ResultCodes.Refused,
            ProcessorFixture.Trusted);
        Assert.Contains("protected folder", refused.Error);
        Assert.Empty(_f.Platform.Shell.Started);
    }

    [Fact]
    public async Task An_ask_runs_only_with_an_approval()
    {
        await _f.Ok("profile.sync", Sync(AnalyserFixture.Scoped), ProcessorFixture.Trusted);
        const string command = @"Remove-Item C:\Users\artem\Pictures\old.png";
        var refused = await _f.Fails("shell", Shell(command, new JsonObject { ["auto"] = new JsonObject { ["rule"] = "x" } }), ResultCodes.Refused, ProcessorFixture.Trusted);
        Assert.Contains("needs the user's approval", refused.Error);
        Assert.Empty(_f.Platform.Shell.Started);

        await _f.Ok("shell", Shell(command, new JsonObject { ["approval"] = new JsonObject { ["id"] = "a1", ["scope"] = "once" } }), ProcessorFixture.Trusted);
        Assert.Single(_f.Platform.Shell.Started);
        // Inside a work folder no approval is needed.
        await _f.Ok("shell", Shell(@"Remove-Item C:\dev\x.log"), ProcessorFixture.Trusted);
        Assert.Equal(2, _f.Platform.Shell.Started.Count);
    }

    [Fact]
    public async Task A_command_decided_with_a_newer_profile_is_refused_as_stale()
    {
        await _f.Ok("profile.sync", Sync(AnalyserFixture.Scoped), ProcessorFixture.Trusted);
        var stale = await _f.Fails("shell", Shell("Get-Date", new JsonObject { ["profile_version"] = 8 }), ResultCodes.ProfileStale, ProcessorFixture.Trusted);
        Assert.Contains("older", stale.Error);
        await _f.Ok("shell", Shell("Get-Date", new JsonObject { ["profile_version"] = 7 }), ProcessorFixture.Trusted);
    }

    [Fact]
    public async Task Without_any_profile_only_the_hard_floor_holds()
    {
        await _f.Ok("shell", Shell(@"Remove-Item C:\Users\artem\Pictures\old.png"), ProcessorFixture.Trusted);
        await _f.Fails("shell", Shell(@"Remove-Item 'C:\Users\artem\AppData\Roaming\Anemo Desktop\permissions.json'"), ResultCodes.Refused, ProcessorFixture.Trusted);
    }

    [Fact]
    public async Task A_profile_without_the_shell_refuses_it_and_a_watched_device_too()
    {
        await _f.Ok("profile.sync", Sync(AnalyserFixture.With("deny")), ProcessorFixture.Trusted);
        await _f.Fails("shell", Shell("Get-Date"), ResultCodes.Refused, ProcessorFixture.Trusted);
        await _f.Fails("shell", Shell("Get-Date"), ResultCodes.Refused, ProcessorFixture.Watched);
    }

    [Fact]
    public async Task With_the_switch_on_a_loosening_waits_for_a_click_and_tightening_does_not()
    {
        await _f.Ok("profile.sync", Sync(AnalyserFixture.Scoped), ProcessorFixture.Trusted);
        _confirm = true;
        string? asked = null;
        _guard.ConfirmationNeeded += text => asked = text;

        var looser = AnalyserFixture.Scoped with
        {
            Version = 8,
            WorkFolders = [.. AnalyserFixture.Scoped.WorkFolders, new WorkFolder(@"C:\Users\artem\Documents\notes", true, "approval:2026-11-27")],
        };
        var answer = await _f.Ok("profile.sync", Sync(looser), ProcessorFixture.Trusted);
        Assert.False((bool)answer["applied"]!);
        Assert.True((bool)answer["pending"]!);
        Assert.Equal(7, _guard.Version); // the old profile is still enforced
        Assert.Equal(@"Anemo wants to make C:\Users\artem\Documents\notes a work folder. Allow?", asked);
        await _f.Fails("shell", Shell(@"Remove-Item C:\Users\artem\Documents\notes\x.md", new JsonObject { ["profile_version"] = 8 }), ResultCodes.ProfileStale, ProcessorFixture.Trusted);

        _guard.Confirm();
        Assert.Equal(8, _guard.Version);
        Assert.False(_guard.Pending);
        await _f.Ok("shell", Shell(@"Remove-Item C:\Users\artem\Documents\notes\x.md", new JsonObject { ["profile_version"] = 8 }), ProcessorFixture.Trusted);

        // Tightening applies at once, switch or not.
        var tighter = looser with { Version = 9, WorkFolders = [new WorkFolder(@"C:\dev", false, "settings")] };
        Assert.True((bool)(await _f.Ok("profile.sync", Sync(tighter), ProcessorFixture.Trusted))["applied"]!);
        Assert.Equal(9, _guard.Version);
    }

    [Fact]
    public void A_rejected_loosening_is_dropped()
    {
        _guard.Sync(Sync(AnalyserFixture.Scoped)["profile"]);
        _confirm = true;
        _guard.Sync(Sync(AnalyserFixture.With("allow") with { Version = 8 })["profile"]);
        Assert.True(_guard.Pending);
        _guard.Reject();
        Assert.False(_guard.Pending);
        Assert.Equal("folders", _guard.Profile.Level("shell"));
    }

    [Fact]
    public void What_loosens()
    {
        var scoped = AnalyserFixture.Scoped;
        Assert.False(scoped.LoosenedBy(scoped));
        Assert.True(scoped.LoosenedBy(AnalyserFixture.With("allow")));
        Assert.False(AnalyserFixture.With("allow").LoosenedBy(scoped));
        // A key folder from deny to ask loosens:
        var denied = scoped with { Protected = new Dictionary<string, string> { ["keys"] = "deny" } };
        Assert.True(denied.LoosenedBy(scoped with { Protected = new Dictionary<string, string> { ["keys"] = "ask" } }));
        Assert.True(scoped.LoosenedBy(scoped with { RelevanceCheck = false }));
        Assert.True(scoped.LoosenedBy(scoped with { AutomationsUnrestricted = true }));
        Assert.False(scoped.LoosenedBy(scoped with { WorkFolders = [] }));
    }

    [Fact]
    public void Hello_names_the_capabilities_and_the_offer_the_profile_version()
    {
        var hello = JsonNode.Parse(Wire.Hello("t", "1.10.0", null, "windows", ["profiles", "shell.analyze"]))!;
        Assert.Equal(["profiles", "shell.analyze"], hello["capabilities"]!.AsArray().Select(c => (string)c!));
        Assert.Null(JsonNode.Parse(Wire.Hello("t", "1.10.0", null))!["capabilities"]);

        var offer = JsonNode.Parse(Wire.Offer(true, true, false, false, profileVersion: 7, profilePending: true))!;
        Assert.Equal(7, (int)offer["profile_version"]!);
        Assert.True((bool)offer["profile_pending"]!);
        Assert.Null(JsonNode.Parse(Wire.Offer(true, true, false, false))!["profile_version"]);
    }
}
