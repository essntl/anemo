using System.Text.Json.Nodes;
using Anemo.Desktop.Core.Commands;
using Anemo.Desktop.Core.Platform;

namespace Anemo.Desktop.Tests.Commands;

public sealed class ActTests : IDisposable
{
    private readonly ProcessorFixture _f = new();

    public void Dispose() => _f.Dispose();

    private Task LookFirst() => _f.Ok("look", new JsonObject { ["what"] = "window" });

    [Fact]
    public async Task Click_on_a_ref_uses_Invoke_and_answers_with_the_new_state()
    {
        await LookFirst();

        var state = await _f.Ok("click", new JsonObject { ["ref"] = "c1" });

        Assert.Equal(["invoke"], _f.Save.Calls);
        Assert.Empty(_f.Platform.Input.Events);
        Assert.NotNull(state["screenshot"]);
        Assert.Equal("c1", (string?)state["controls"]!.AsArray()[0]!["ref"]);
    }

    [Fact]
    public async Task Click_without_Invoke_uses_the_mouse_on_the_control()
    {
        await LookFirst();

        await _f.Ok("click", new JsonObject { ["ref"] = "c2" });

        Assert.Equal(["invoke", "prepare"], _f.Name.Calls);
        Assert.Equal(["click:640,220:Left:1"], _f.Platform.Input.Events);
    }

    [Fact]
    public async Task Double_and_right_click_use_the_mouse()
    {
        await LookFirst();
        await _f.Ok("double_click", new JsonObject { ["ref"] = "c1" });
        await _f.Ok("right_click", new JsonObject { ["ref"] = "c1" });

        Assert.Equal(["click:500,300:Left:2", "click:500,300:Right:1"], _f.Platform.Input.Events);
        Assert.DoesNotContain("invoke", _f.Save.Calls);
    }

    [Fact]
    public async Task Click_by_coordinates_is_scaled_back_to_the_screen()
    {
        // The window is at (100, 50), captured at scale 2.
        await LookFirst();

        await _f.Ok("click", new JsonObject { ["x"] = 10, ["y"] = 20.5 });

        Assert.Equal(["click:120,91:Left:1"], _f.Platform.Input.Events);
    }

    [Fact]
    public async Task Click_by_coordinates_of_a_screen_look()
    {
        _f.Platform.Desktop.Screen = new ScreenRect(-1920, 0, 3840, 1080);
        await _f.Ok("look", new JsonObject { ["what"] = "screen" });

        await _f.Ok("click", new JsonObject { ["x"] = 100, ["y"] = 100 });

        Assert.Equal(["click:-1720,200:Left:1"], _f.Platform.Input.Events);
    }

    [Fact]
    public async Task Click_before_any_screenshot_uses_the_whole_screen()
    {
        _f.Platform.Desktop.Screen = new ScreenRect(0, 0, 3136, 1764);

        await _f.Ok("click", new JsonObject { ["x"] = 784, ["y"] = 441 });

        Assert.Equal(["click:1568,882:Left:1"], _f.Platform.Input.Events);
    }

    [Fact]
    public async Task Coordinates_outside_the_screenshot_fail()
    {
        await LookFirst();

        var outcome = await _f.Fails("click", new JsonObject { ["x"] = 5000, ["y"] = 1 }, ResultCodes.Failed);

        Assert.Contains("inside the last screenshot", outcome.Error);
        Assert.Empty(_f.Platform.Input.Events);
    }

    [Fact]
    public async Task Click_without_ref_or_coordinates_fails()
    {
        var outcome = await _f.Fails("click", new JsonObject(), ResultCodes.Failed);

        Assert.Equal("Give a control's ref, or x and y.", outcome.Error);
    }

    [Fact]
    public async Task An_unknown_ref_is_stale()
    {
        await LookFirst();

        var outcome = await _f.Fails("click", new JsonObject { ["ref"] = "c99" }, ResultCodes.Failed);

        Assert.Equal("That control is gone; look again", outcome.Error);
    }

    [Fact]
    public async Task Refs_are_valid_for_the_next_command_only()
    {
        await LookFirst();
        await _f.Ok("clipboard_set", new JsonObject { ["text"] = "x" });

        var outcome = await _f.Fails("click", new JsonObject { ["ref"] = "c1" }, ResultCodes.Failed);

        Assert.Equal("That control is gone; look again", outcome.Error);
    }

    [Fact]
    public async Task A_control_that_disappeared_is_stale()
    {
        await LookFirst();
        _f.Save.Gone = true;

        var outcome = await _f.Fails("click", new JsonObject { ["ref"] = "c1" }, ResultCodes.Failed);

        Assert.Equal("That control is gone; look again", outcome.Error);
    }

    [Fact]
    public async Task Type_into_a_ref_sets_its_value()
    {
        await LookFirst();

        await _f.Ok("type", new JsonObject { ["text"] = "Grace", ["ref"] = "c2" });

        Assert.Equal(["set_value:Grace"], _f.Name.Calls);
        Assert.Empty(_f.Platform.Input.Events);
    }

    [Fact]
    public async Task Type_into_a_control_without_Value_focuses_it_and_types()
    {
        var element = new Fakes.FakeElement { CanSetValue = false, Desktop = _f.Platform.Desktop };
        _f.Platform.Desktop.Tree = _ => new UiTree([new UiNode(0, "document", "Body", null, true, false, true, element)], false);
        await LookFirst();

        await _f.Ok("type", new JsonObject { ["text"] = "Dear Tim,", ["ref"] = "c1" });

        Assert.Equal(["set_value:Dear Tim,", "focus"], element.Calls);
        Assert.Equal(["type:Dear Tim,"], _f.Platform.Input.Events);
    }

    [Fact]
    public async Task Type_into_a_password_ref_is_refused()
    {
        await LookFirst();

        var outcome = await _f.Fails("type", new JsonObject { ["text"] = "secret", ["ref"] = "c3" }, ResultCodes.Refused);

        Assert.Equal(CommandProcessor.PasswordMessage, outcome.Error);
        Assert.Empty(_f.Pass.Calls);
        Assert.Empty(_f.Platform.Input.Events);
    }

    [Fact]
    public async Task Type_where_the_focus_is_a_password_field_is_refused()
    {
        _f.Platform.Desktop.Focused = _f.Pass;

        var outcome = await _f.Fails("type", new JsonObject { ["text"] = "secret" }, ResultCodes.Refused);

        Assert.Equal(CommandProcessor.PasswordMessage, outcome.Error);
        Assert.Empty(_f.Platform.Input.Events);
    }

    [Fact]
    public async Task Type_where_the_focus_is()
    {
        _f.Platform.Desktop.Focused = _f.Name;

        await _f.Ok("type", new JsonObject { ["text"] = "hello" });

        Assert.Equal(["type:hello"], _f.Platform.Input.Events);
    }

    [Fact]
    public async Task Type_longer_than_5000_characters_fails()
    {
        await _f.Fails("type", new JsonObject { ["text"] = new string('a', 5001) }, ResultCodes.Failed);
        Assert.Empty(_f.Platform.Input.Events);
    }

    [Fact]
    public async Task Stopping_in_the_middle_of_typing_cancels_it()
    {
        using var cts = new CancellationTokenSource();
        _f.Platform.Input.OnTypedChar = i =>
        {
            if (i == 3)
            {
                cts.Cancel();
            }
        };

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => _f.Run("type", new JsonObject { ["text"] = "a long sentence" }, ct: cts.Token));
        Assert.Empty(_f.Platform.Input.Events);
    }

    [Fact]
    public async Task Press_sends_each_combo()
    {
        await _f.Ok("press", new JsonObject { ["keys"] = new JsonArray("Control+s", "Win+r", "Enter") });

        Assert.Equal(["press:11|53", "press:5B|52", "press:|0D"], _f.Platform.Input.Events);
    }

    [Fact]
    public async Task Press_refuses_ctrl_alt_del_and_presses_nothing()
    {
        var outcome = await _f.Fails("press", new JsonObject { ["keys"] = new JsonArray("Enter", "Control+Alt+Delete") }, ResultCodes.Refused);

        Assert.Contains("Ctrl+Alt+Del", outcome.Error);
        Assert.Empty(_f.Platform.Input.Events);
    }

    [Fact]
    public async Task Press_fails_on_an_unknown_key_and_presses_nothing()
    {
        await _f.Fails("press", new JsonObject { ["keys"] = new JsonArray("Enter", "F13") }, ResultCodes.Failed);
        await _f.Fails("press", new JsonObject { ["keys"] = new JsonArray() }, ResultCodes.Failed);
        await _f.Fails("press", new JsonObject { ["keys"] = new JsonArray(Enumerable.Range(0, 11).Select(_ => (JsonNode?)JsonValue.Create("a")).ToArray()) }, ResultCodes.Failed);

        Assert.Empty(_f.Platform.Input.Events);
    }

    [Fact]
    public async Task Scroll_uses_the_Scroll_pattern_or_the_wheel()
    {
        var scrollable = new Fakes.FakeElement { CanScroll = true };
        _f.Platform.Desktop.Tree = _ => new UiTree(
            [new UiNode(0, "list", "Files", null, true, false, true, scrollable), new UiNode(0, "pane", "P", null, true, false, true, _f.Name)], false);
        await LookFirst();
        await _f.Ok("scroll", new JsonObject { ["direction"] = "down", ["amount"] = 3, ["ref"] = "c1" });
        await _f.Ok("scroll", new JsonObject { ["direction"] = "left", ["amount"] = 2, ["ref"] = "c2" });
        await _f.Ok("scroll", new JsonObject { ["direction"] = "up", ["amount"] = 1 });

        Assert.Equal(["scroll:Down:3"], scrollable.Calls);
        Assert.Equal(["scroll:640,220:Left:2", "scroll:900,550:Up:1"], _f.Platform.Input.Events);
    }

    [Fact]
    public async Task Scroll_checks_its_fields()
    {
        await _f.Fails("scroll", new JsonObject { ["direction"] = "sideways", ["amount"] = 1 }, ResultCodes.Failed);
        await _f.Fails("scroll", new JsonObject { ["direction"] = "up", ["amount"] = 11 }, ResultCodes.Failed);
        Assert.Empty(_f.Platform.Input.Events);
    }

    [Fact]
    public async Task Focus_window_brings_the_window_up()
    {
        await _f.Ok("look", new JsonObject { ["what"] = "windows" });

        var state = await _f.Ok("focus_window", new JsonObject { ["window_ref"] = "w2" });

        Assert.Contains("focus_window:1002", _f.Platform.Desktop.Calls);
        Assert.Equal("Notes - Notepad", (string?)state["window"]!["title"]);
    }

    [Fact]
    public async Task Open_a_url_in_the_default_browser()
    {
        await _f.Ok("open", new JsonObject { ["target"] = "https://example.com/page?q=1" });

        Assert.Equal(["https://example.com/page?q=1"], _f.Platform.Apps.Launched);
    }

    [Theory]
    [InlineData("file:///C:/Windows/System32/cmd.exe")]
    [InlineData("ms-settings://privacy")]
    [InlineData("javascript://alert(1)")]
    public async Task Open_refuses_other_kinds_of_address(string target)
    {
        await _f.Fails("open", new JsonObject { ["target"] = target }, ResultCodes.Failed);
        Assert.Empty(_f.Platform.Apps.Launched);
    }

    [Theory]
    [InlineData("excel", "Microsoft.Office.EXCEL.EXE.15")]
    [InlineData("Notepad", "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App")]
    [InlineData("calc", "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App")]
    [InlineData("Visual Studio Code", "Microsoft.VisualStudioCode")]
    public async Task Open_a_program_from_the_Start_menu(string name, string launched)
    {
        await _f.Ok("open", new JsonObject { ["target"] = name });

        Assert.Equal([launched], _f.Platform.Apps.Launched);
    }

    [Fact]
    public async Task Open_an_ambiguous_or_missing_program_fails()
    {
        var several = await _f.Fails("open", new JsonObject { ["target"] = "Visual" }, ResultCodes.Failed);
        var none = await _f.Fails("open", new JsonObject { ["target"] = "Photoshop" }, ResultCodes.Failed);

        Assert.Contains("several programs", several.Error);
        Assert.Contains("no program", none.Error);
        Assert.Empty(_f.Platform.Apps.Launched);
    }

    [Fact]
    public async Task Clipboard_set_answers_an_empty_object()
    {
        var state = await _f.Ok("clipboard_set", new JsonObject { ["text"] = "copied" });

        Assert.Equal("{}", state.ToJsonString());
        Assert.Equal("copied", _f.Platform.Clipboard.Text);
    }

    [Fact]
    public async Task Clipboard_set_over_20000_characters_fails()
    {
        await _f.Fails("clipboard_set", new JsonObject { ["text"] = new string('a', 20_001) }, ResultCodes.Failed);
        Assert.Null(_f.Platform.Clipboard.Text);
    }

    [Theory]
    [InlineData("click")]
    [InlineData("double_click")]
    [InlineData("right_click")]
    [InlineData("type")]
    [InlineData("press")]
    [InlineData("scroll")]
    [InlineData("focus_window")]
    [InlineData("open")]
    [InlineData("clipboard_set")]
    public async Task Every_action_is_refused_while_control_is_off(string action)
    {
        await LookFirst();
        _f.Control.SetAllow(false);

        var outcome = await _f.Fails(action, AnyFields(action), ResultCodes.Refused);

        Assert.Contains("Allow control", outcome.Error);
        AssertNothingDone();
    }

    [Theory]
    [InlineData("click")]
    [InlineData("type")]
    [InlineData("clipboard_set")]
    public async Task Every_action_is_refused_while_control_is_paused(string action)
    {
        await LookFirst();
        _f.Control.Stop();

        var outcome = await _f.Fails(action, AnyFields(action), ResultCodes.Refused);

        Assert.Contains("paused", outcome.Error);
        AssertNothingDone();
    }

    [Fact]
    public async Task Control_comes_back_after_the_hour()
    {
        _f.Control.Stop();
        _f.Time.Now += TimeSpan.FromMinutes(61);

        await _f.Ok("clipboard_set", new JsonObject { ["text"] = "x" });
    }

    [Fact]
    public async Task On_the_secure_desktop_acting_is_not_tried()
    {
        await LookFirst();
        _f.Platform.Desktop.Secure = true;

        var outcome = await _f.Fails("click", new JsonObject { ["ref"] = "c1" }, ResultCodes.Unavailable);

        Assert.Equal(CommandProcessor.SecureDesktopMessage, outcome.Error);
        AssertNothingDone();
    }

    [Fact]
    public async Task A_click_on_Anemo_Desktops_own_window_is_refused()
    {
        await LookFirst();
        _f.Platform.Desktop.OwnWindow = new ScreenRect(100, 50, 200, 100);

        var byPoint = await _f.Fails("click", new JsonObject { ["x"] = 10, ["y"] = 10 }, ResultCodes.Refused);
        await LookFirst();
        _f.Platform.Desktop.OwnWindow = new ScreenRect(600, 200, 100, 100);
        var byRef = await _f.Fails("click", new JsonObject { ["ref"] = "c2" }, ResultCodes.Refused);

        Assert.Equal(CommandProcessor.OwnWindowMessage, byPoint.Error);
        Assert.Equal(CommandProcessor.OwnWindowMessage, byRef.Error);
        Assert.Empty(_f.Platform.Input.Events);
    }

    [Fact]
    public async Task Keys_are_not_sent_to_Anemo_Desktops_own_window()
    {
        _f.Platform.Desktop.OwnWindowInFront = true;

        await _f.Fails("type", new JsonObject { ["text"] = "x" }, ResultCodes.Refused);
        await _f.Fails("press", new JsonObject { ["keys"] = new JsonArray("Space") }, ResultCodes.Refused);

        Assert.Empty(_f.Platform.Input.Events);
    }

    private void AssertNothingDone()
    {
        Assert.Empty(_f.Platform.Input.Events);
        Assert.Empty(_f.Platform.Apps.Launched);
        Assert.Null(_f.Platform.Clipboard.Text);
        Assert.Empty(_f.Save.Calls);
        Assert.DoesNotContain(_f.Platform.Desktop.Calls, c => c.StartsWith("focus_window", StringComparison.Ordinal));
    }

    private static JsonObject AnyFields(string action) => action switch
    {
        "type" => new JsonObject { ["text"] = "hi" },
        "press" => new JsonObject { ["keys"] = new JsonArray("Enter") },
        "scroll" => new JsonObject { ["direction"] = "down", ["amount"] = 1 },
        "focus_window" => new JsonObject { ["window_ref"] = "w1" },
        "open" => new JsonObject { ["target"] = "https://example.com" },
        "clipboard_set" => new JsonObject { ["text"] = "hi" },
        _ => new JsonObject { ["ref"] = "c1" },
    };
}
