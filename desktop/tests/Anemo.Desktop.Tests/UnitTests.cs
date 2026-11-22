using System.Text.Json.Nodes;
using Anemo.Desktop.Core;
using Anemo.Desktop.Core.Commands;
using Anemo.Desktop.Core.Connection;
using Anemo.Desktop.Core.Control;
using Anemo.Desktop.Core.Platform;
using Anemo.Desktop.Core.Protocol;
using Anemo.Desktop.Core.Storage;
using Anemo.Desktop.Tests.Fakes;

namespace Anemo.Desktop.Tests;

public sealed class KeyParserTests
{
    [Theory]
    [InlineData("Enter", "", 0x0D)]
    [InlineData("Escape", "", 0x1B)]
    [InlineData("ArrowDown", "", 0x28)]
    [InlineData("PageUp", "", 0x21)]
    [InlineData("a", "", 0x41)]
    [InlineData("7", "", 0x37)]
    [InlineData("Control+a", "11", 0x41)]
    [InlineData("Shift+Tab", "10", 0x09)]
    [InlineData("Control+Shift+Escape", "11,10", 0x1B)]
    [InlineData("Alt+Space", "12", 0x20)]
    [InlineData("Meta+e", "5B", 0x45)]
    [InlineData("Win+d", "5B", 0x44)]
    public void Parses_the_contract_key_names(string text, string modifiers, int key)
    {
        var combo = KeyParser.Parse(text);

        Assert.Equal(modifiers, string.Join(",", combo.Modifiers.Select(m => m.ToString("X2"))));
        Assert.Equal(key, combo.Key);
    }

    [Theory]
    [InlineData("A")]
    [InlineData("F5")]
    [InlineData("Ctrl+a")]
    [InlineData("Control+")]
    [InlineData("+a")]
    [InlineData("Control+Control+a")]
    [InlineData("enter")]
    [InlineData("Win")]
    [InlineData("é")]
    public void Refuses_anything_else(string text)
    {
        var e = Assert.Throws<CommandException>(() => KeyParser.Parse(text));
        Assert.Equal(ResultCodes.Failed, e.Code);
    }

    [Theory]
    [InlineData("Control+Alt+Delete")]
    [InlineData("Alt+Control+Delete")]
    [InlineData("Control+Alt+Shift+Delete")]
    public void Never_ctrl_alt_del(string text)
    {
        var e = Assert.Throws<CommandException>(() => KeyParser.Parse(text));
        Assert.Equal(ResultCodes.Refused, e.Code);
    }

    [Fact]
    public void Extended_keys_are_known()
    {
        Assert.True(KeyCombo.IsExtended(0x28));
        Assert.True(KeyCombo.IsExtended(KeyParser.VkDelete));
        Assert.False(KeyCombo.IsExtended(0x41));
    }
}

public sealed class HotkeyTests
{
    [Fact]
    public void The_default_stop_key_parses()
    {
        var key = Hotkey.Parse(Hotkey.DefaultStop)!;

        Assert.Equal(HotkeyModifiers.Control | HotkeyModifiers.Alt | HotkeyModifiers.Shift, key.Modifiers);
        Assert.Equal((uint)'S', key.Key);
        Assert.Equal("Ctrl+Alt+Shift+S", key.ToString());
    }

    [Theory]
    [InlineData("ctrl + alt + f9", "Ctrl+Alt+F9")]
    [InlineData("Win+Shift+1", "Shift+Win+1")]
    [InlineData("Control+Alt+A", "Ctrl+Alt+A")]
    public void Changed_keys_parse(string text, string normal) => Assert.Equal(normal, Hotkey.Parse(text)!.ToString());

    [Theory]
    [InlineData("")]
    [InlineData("S")]
    [InlineData("Ctrl+S")]
    [InlineData("Shift+Shift+S")]
    [InlineData("Shift+Alt")]
    [InlineData("Ctrl+Alt+F13")]
    [InlineData("Ctrl+Alt+Enter")]
    public void Bad_keys_are_null(string text) => Assert.Null(Hotkey.Parse(text));
}

public sealed class AnemoAddressTests
{
    [Theory]
    [InlineData("https://anemo.example.com", "wss://anemo.example.com/api/devices/ws")]
    [InlineData("https://anemo.example.com/", "wss://anemo.example.com/api/devices/ws")]
    [InlineData("anemo.example.com", "wss://anemo.example.com/api/devices/ws")]
    [InlineData("https://example.com:8443/anemo/", "wss://example.com:8443/anemo/api/devices/ws")]
    [InlineData("http://127.0.0.1:5000", "ws://127.0.0.1:5000/api/devices/ws")]
    [InlineData("http://localhost:8000", "ws://localhost:8000/api/devices/ws")]
    public void Builds_the_websocket_url(string typed, string ws)
    {
        var address = AnemoAddress.Parse(typed)!;

        Assert.Equal(ws, address.WebSocketUri.ToString());
        Assert.EndsWith("/api/devices/shared-screen", address.SharedScreenUri.ToString());
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("http://anemo.example.com")]
    [InlineData("ftp://anemo.example.com")]
    [InlineData("https://anemo.example.com/?token=anemo_x")]
    [InlineData("https://user:pw@anemo.example.com")]
    public void Refuses_insecure_or_odd_addresses(string? typed) => Assert.Null(AnemoAddress.Parse(typed));
}

public sealed class BackoffTests
{
    [Fact]
    public void Doubles_up_to_the_maximum_and_resets()
    {
        var backoff = new Backoff(TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(60), new Random(1));
        var waits = Enumerable.Range(0, 10).Select(_ => backoff.Next().TotalSeconds).ToList();

        Assert.InRange(waits[0], 0.8, 1.2);
        Assert.InRange(waits[1], 1.6, 2.4);
        Assert.InRange(waits[2], 3.2, 4.8);
        Assert.All(waits, w => Assert.True(w <= 60));
        Assert.InRange(waits[9], 48, 60);

        backoff.Reset();
        Assert.InRange(backoff.Next().TotalSeconds, 0.8, 1.2);
    }
}

public sealed class OutputCaptureTests
{
    [Fact]
    public void Short_output_is_kept_whole()
    {
        var capture = new OutputCapture(10, 5);
        capture.Append("abcdefghij");
        capture.Append("klmno");

        Assert.Equal("abcdefghijklmno", capture.ToString());
        Assert.False(capture.Truncated);
    }

    [Fact]
    public void Long_output_keeps_head_and_tail_and_says_how_much_was_cut()
    {
        var capture = new OutputCapture(10, 5);
        foreach (var c in "abcdefghij0123456789KLMNOPQRSTUVWXYZ")
        {
            capture.Append(c.ToString());
        }

        Assert.True(capture.Truncated);
        Assert.Equal("abcdefghij\n[… 21 characters cut …]\nVWXYZ", capture.ToString());
    }

    [Fact]
    public void The_real_limits_are_20000_and_10000()
    {
        var capture = new OutputCapture();
        capture.Append(new string('h', 20_000));
        capture.Append(new string('m', 50_000));
        capture.Append(new string('t', 10_000));

        var text = capture.ToString();
        Assert.StartsWith(new string('h', 20_000) + "\n[… 50000 characters cut …]\n", text);
        Assert.EndsWith(new string('t', 10_000), text);
    }
}

public sealed class ScreenshotScalerTests
{
    [Theory]
    [InlineData(1920, 1080, 1568, 882, 1.2245)]
    [InlineData(3840, 2160, 1568, 882, 2.449)]
    [InlineData(1080, 1920, 882, 1568, 1.2245)]
    [InlineData(1280, 720, 1280, 720, 1.0)]
    [InlineData(1568, 100, 1568, 100, 1.0)]
    public void Fits_the_long_side_into_1568(int w, int h, int tw, int th, double scale)
    {
        var (width, height, s) = ScreenshotScaler.Fit(w, h);

        Assert.Equal(tw, width);
        Assert.Equal(th, height);
        Assert.Equal(scale, s, 3);
        Assert.True(Math.Max(width, height) <= ScreenshotScaler.MaxSide);
    }

    [Fact]
    public void Points_go_back_to_the_screen()
    {
        var capture = new ScreenCapture([], 1568, 882, 2.449, -3840, 0);

        Assert.Equal(new ScreenPoint(-3840 + 245, 122), ScreenshotScaler.ToScreen(capture, 100, 50));
    }
}

public sealed class SettingsStoreTests : IDisposable
{
    private readonly string _folder = Path.Combine(Path.GetTempPath(), "anemo-desktop-tests", Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_folder))
        {
            Directory.Delete(_folder, true);
        }
    }

    [Fact]
    public void Defaults_without_a_file()
    {
        var settings = new SettingsStore(Path.Combine(_folder, "settings.json"), new FakeProtector()).Load();

        Assert.True(settings.AllowControl);
        Assert.False(settings.PowerShellEnabled);
        Assert.True(settings.StartWithWindows);
        Assert.Equal("Ctrl+Alt+Shift+S", settings.StopHotkey);
        Assert.Equal("Ctrl+Alt+Shift+A", settings.ShareHotkey);
        Assert.Null(settings.ProtectedToken);
    }

    [Fact]
    public void The_token_is_saved_only_protected()
    {
        var path = Path.Combine(_folder, "settings.json");
        var store = new SettingsStore(path, new FakeProtector());
        var settings = store.WithToken(new DesktopSettings { Address = "https://anemo.example.com", PowerShellEnabled = true }, " anemo_Secret123 ");

        store.Save(settings);

        var file = File.ReadAllText(path);
        Assert.DoesNotContain("anemo_Secret123", file);
        var loaded = store.Load();
        Assert.Equal("anemo_Secret123", store.Token(loaded));
        Assert.True(loaded.PowerShellEnabled);
        Assert.Equal("https://anemo.example.com", loaded.Address);
    }

    [Fact]
    public void A_broken_file_gives_defaults_and_is_kept_aside()
    {
        Directory.CreateDirectory(_folder);
        var path = Path.Combine(_folder, "settings.json");
        File.WriteAllText(path, "{ not json");

        var store = new SettingsStore(path, new FakeProtector());
        var settings = store.Load();

        Assert.False(settings.AllowControl);
        Assert.Contains("control switched off", store.LoadProblem);
        Assert.True(File.Exists(path + ".broken"));
    }

    [Fact]
    public void An_unreadable_file_starts_with_control_off()
    {
        // A folder where the file should be: reading it fails with an access or IO error.
        var path = Path.Combine(_folder, "settings.json");
        Directory.CreateDirectory(path);
        File.WriteAllText(Path.Combine(path, "x"), "");

        var store = new SettingsStore(path, new FakeProtector());
        var settings = store.Load();

        Assert.False(settings.AllowControl);
        Assert.NotNull(store.LoadProblem);
    }

    [Fact]
    public void No_file_yet_is_not_a_problem()
    {
        var store = new SettingsStore(Path.Combine(_folder, "settings.json"), new FakeProtector());

        Assert.True(store.Load().AllowControl);
        Assert.Null(store.LoadProblem);
    }

    [Fact]
    public void A_file_that_cannot_be_written_says_so()
    {
        Directory.CreateDirectory(_folder);
        var blocker = Path.Combine(_folder, "not-a-folder");
        File.WriteAllText(blocker, "");
        var store = new SettingsStore(Path.Combine(blocker, "settings.json"), new FakeProtector());

        var e = Assert.Throws<SettingsSaveException>(() => store.Save(new DesktopSettings()));
        Assert.Contains("couldn't be saved", e.Message);
    }

    [Fact]
    public void A_token_Windows_cannot_protect_gives_a_sentence()
    {
        var store = new SettingsStore(Path.Combine(_folder, "settings.json"), new ThrowingProtector());

        var e = Assert.Throws<SettingsSaveException>(() => store.WithToken(new DesktopSettings(), "anemo_x"));
        Assert.Contains("protect the token", e.Message);
        Assert.DoesNotContain("anemo_x", e.Message);
    }

    private sealed class ThrowingProtector : Anemo.Desktop.Core.Platform.ITokenProtector
    {
        public string Protect(string token) => throw new System.Security.Cryptography.CryptographicException("no profile");

        public string? Unprotect(string protectedToken) => null;
    }

    [Fact]
    public void A_token_that_cannot_be_unprotected_is_no_token()
    {
        var store = new SettingsStore(Path.Combine(_folder, "settings.json"), new FakeProtector());

        Assert.Null(store.Token(new DesktopSettings { ProtectedToken = "from-another-user" }));
    }
}

public sealed class ControlStateTests
{
    [Fact]
    public void Stop_pauses_for_an_hour_and_says_so()
    {
        var time = new ManualTime();
        var control = new ControlState(time, true, null);
        var stops = 0;
        var changes = 0;
        control.StopRequested += () => stops++;
        control.Changed += () => changes++;

        control.Stop();

        Assert.False(control.Effective);
        Assert.Equal(time.Now + TimeSpan.FromHours(1), control.PausedUntil);
        Assert.Contains("paused", control.RefusalReason());
        Assert.Equal(1, stops);
        Assert.Equal(1, changes);

        time.Now += TimeSpan.FromMinutes(60) + TimeSpan.FromSeconds(1);
        Assert.True(control.Effective);
        Assert.Null(control.PausedUntil);
    }

    [Fact]
    public void Resume_ends_the_pause()
    {
        var control = new ControlState(new ManualTime(), true, null);
        control.Stop();

        control.Resume();

        Assert.True(control.Effective);
    }

    [Fact]
    public void The_stop_is_raised_before_the_change()
    {
        var control = new ControlState(new ManualTime(), true, null);
        var order = new List<string>();
        control.StopRequested += () => order.Add("stop");
        control.Changed += () => order.Add("changed");

        control.Stop();
        control.SetAllow(false);

        Assert.Equal(["stop", "changed", "stop", "changed"], order);
    }

    [Fact]
    public void Switching_control_off_stops_what_runs()
    {
        var control = new ControlState(new ManualTime(), true, null);
        var stops = 0;
        control.StopRequested += () => stops++;

        control.SetAllow(false);
        control.SetAllow(false);

        Assert.False(control.Effective);
        Assert.Equal(1, stops);
        Assert.Contains("Allow control", control.RefusalReason());

        control.SetAllow(true);
        Assert.Equal(1, stops);
        Assert.True(control.Effective);
    }

    [Fact]
    public void A_saved_pause_still_holds_after_a_restart()
    {
        var time = new ManualTime();
        var control = new ControlState(time, true, time.Now + TimeSpan.FromMinutes(10));

        Assert.False(control.Effective);
    }
}

public sealed class TrayStatusTests
{
    [Fact]
    public void Grey_normal_red()
    {
        Assert.Equal(TrayIcon.Grey, TrayStatus.Icon(new ConnectionStatus(ConnectionPhase.Waiting), false));
        Assert.Equal(TrayIcon.Grey, TrayStatus.Icon(new ConnectionStatus(ConnectionPhase.Refused, "x"), true));
        Assert.Equal(TrayIcon.Normal, TrayStatus.Icon(new ConnectionStatus(ConnectionPhase.Connected), false));
        Assert.Equal(TrayIcon.Red, TrayStatus.Icon(new ConnectionStatus(ConnectionPhase.Connected), true));
    }

    [Fact]
    public void The_tooltip_says_the_state_and_fits()
    {
        var control = new ControlState(new ManualTime(), false, null);

        var text = TrayStatus.Tooltip(new ConnectionStatus(ConnectionPhase.Refused, new string('x', 300)), false, control);

        Assert.True(text.Length <= TrayStatus.MaxTooltip);
        Assert.StartsWith("Anemo Desktop: not connected", text);
        Assert.Contains("control off", TrayStatus.Tooltip(new ConnectionStatus(ConnectionPhase.Connected), false, control));
    }
}

public sealed class WireTests
{
    [Fact]
    public void Messages_have_the_contract_shapes()
    {
        Assert.Equal("""{"type":"hello","token":"anemo_t","kind":"computer","version":"1.0.0","last_id":null}""", Wire.Hello("anemo_t", "1.0.0", null));
        Assert.Equal("""{"type":"ping"}""", Wire.Ping());
        Assert.Equal("""{"type":"device.offer","control":true,"shell":false}""", Wire.Offer(true, false));
        Assert.Equal("""{"type":"device.stopped"}""", Wire.Stopped());
        Assert.Equal("""{"type":"device.result","id":"1","ok":true,"state":{}}""", Wire.Result("1", CommandOutcome.Success(new JsonObject())));
        Assert.Equal("""{"type":"device.result","id":"2","ok":false,"error":"No.","code":"refused"}""", Wire.Result("2", CommandOutcome.Fail("refused", "No.")));
    }

    [Fact]
    public void Base64_and_text_are_not_escaped()
    {
        var text = Wire.Result("1", CommandOutcome.Success(new JsonObject { ["screenshot"] = "iVBO+w/==", ["title"] = "Grüße “x”" }));

        Assert.Contains("iVBO+w/==", text);
        Assert.Contains("Grüße “x”", text);
    }

    [Fact]
    public void A_result_over_12_MB_becomes_a_failure()
    {
        var text = Wire.Result("1", CommandOutcome.Success(new JsonObject { ["screenshot"] = new string('A', Wire.MaxResultBytes) }));

        var msg = JsonNode.Parse(text)!;
        Assert.False((bool)msg["ok"]!);
        Assert.Equal("failed", (string?)msg["code"]);
        Assert.Equal(Wire.TooLargeMessage, (string?)msg["error"]);
    }

    [Fact]
    public void Errors_are_cut_to_500_characters()
    {
        var msg = JsonNode.Parse(Wire.Result("1", CommandOutcome.Fail("failed", new string('e', 900))))!;

        Assert.Equal(500, ((string)msg["error"]!).Length);
    }

    [Fact]
    public void Welcome_gives_the_device()
    {
        var welcome = Wire.Parse("""{"type":"welcome","device":{"id":"d","name":"VM","kind":"computer","trust":"trusted"},"missed":false,"cursor":"c"}""")!;

        var device = Wire.Device(welcome)!;
        Assert.Equal("VM", device.Name);
        Assert.True(device.Trusted);
        Assert.Null(Wire.Parse("not json"));
        Assert.Null(Wire.Parse("""{"no":"type"}"""));
        Assert.Null(Wire.Device(Wire.Parse("""{"type":"welcome"}""")!));
    }
}

public sealed class DiagnosticLogTests
{
    [Fact]
    public void Tokens_are_redacted()
    {
        Assert.Equal("hello with anemo_… sent", DiagnosticLog.Redact("hello with anemo_AbC-12_x.y sent"));
    }

    [Fact]
    public void The_file_never_holds_a_token()
    {
        var folder = Path.Combine(Path.GetTempPath(), "anemo-desktop-tests", Guid.NewGuid().ToString("N"));
        try
        {
            new DiagnosticLog(folder, new ManualTime()).Info("failed: Bearer anemo_SuperSecret");

            var text = File.ReadAllText(Directory.GetFiles(folder).Single());
            Assert.DoesNotContain("SuperSecret", text);
            Assert.Contains("Bearer anemo_…", text);
        }
        finally
        {
            Directory.Delete(folder, true);
        }
    }
}
