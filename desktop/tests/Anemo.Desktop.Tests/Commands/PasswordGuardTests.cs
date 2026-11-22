using System.Text.Json.Nodes;
using Anemo.Desktop.Core.Commands;
using Anemo.Desktop.Core.Platform;
using Anemo.Desktop.Tests.Fakes;

namespace Anemo.Desktop.Tests.Commands;

/// <summary>No way around "never type into a password field" (review B1), and the own-window guard per key.</summary>
public sealed class PasswordGuardTests : IDisposable
{
    private readonly ProcessorFixture _f = new();

    public void Dispose() => _f.Dispose();

    [Theory]
    [InlineData("s")]
    [InlineData("7")]
    [InlineData("Shift+s")]
    [InlineData("Space")]
    [InlineData("Control+v")]
    public async Task Press_refuses_text_keys_into_a_password_field(string key)
    {
        _f.Platform.Desktop.Focused = _f.Pass;

        var outcome = await _f.Fails("press", new JsonObject { ["keys"] = new JsonArray(key) }, ResultCodes.Refused);

        Assert.Equal(CommandProcessor.PasswordMessage, outcome.Error);
        Assert.Empty(_f.Platform.Input.Events);
    }

    [Theory]
    [InlineData("Enter")]
    [InlineData("Tab")]
    [InlineData("Control+a")]
    [InlineData("Backspace")]
    public async Task Press_allows_keys_that_dont_enter_text_into_a_password_field(string key)
    {
        _f.Platform.Desktop.Focused = _f.Pass;

        await _f.Ok("press", new JsonObject { ["keys"] = new JsonArray(key) });

        Assert.Single(_f.Platform.Input.Events);
    }

    [Fact]
    public async Task Press_checks_the_focus_before_every_key()
    {
        // A click put the focus on a user name; Tab moves it to the password.
        _f.Platform.Input.AfterPress = combo =>
        {
            if (combo.Key == 0x09)
            {
                _f.Platform.Desktop.Focused = _f.Pass;
            }
        };

        var outcome = await _f.Fails("press", new JsonObject { ["keys"] = new JsonArray("a", "Tab", "s", "e") }, ResultCodes.Refused);

        Assert.Equal(CommandProcessor.PasswordMessage, outcome.Error);
        Assert.Equal(["press:|41", "press:|09"], _f.Platform.Input.Events);
    }

    [Fact]
    public async Task Clipboard_then_paste_into_a_password_field_is_refused()
    {
        await _f.Ok("clipboard_set", new JsonObject { ["text"] = "hunter2" });
        _f.Platform.Desktop.Focused = _f.Pass;

        await _f.Fails("press", new JsonObject { ["keys"] = new JsonArray("Control+v") }, ResultCodes.Refused);

        Assert.Empty(_f.Platform.Input.Events);
    }

    [Fact]
    public async Task Type_stops_when_a_Tab_moves_the_focus_into_a_password_field()
    {
        _f.Platform.Input.AfterType = piece =>
        {
            if (piece.EndsWith('\t'))
            {
                _f.Platform.Desktop.Focused = _f.Pass;
            }
        };

        var outcome = await _f.Fails("type", new JsonObject { ["text"] = "alice\tSecret!" }, ResultCodes.Refused);

        Assert.Equal(CommandProcessor.PasswordMessage, outcome.Error);
        Assert.Equal(["type:alice\t"], _f.Platform.Input.Events);
    }

    [Fact]
    public async Task Type_checks_again_after_every_line_break()
    {
        var pieces = 0;
        _f.Platform.Input.AfterType = _ =>
        {
            if (++pieces == 2)
            {
                _f.Platform.Desktop.Focused = _f.Pass;
            }
        };

        await _f.Fails("type", new JsonObject { ["text"] = "one\ntwo\nthree" }, ResultCodes.Refused);

        Assert.Equal(["type:one\n", "type:two\n"], _f.Platform.Input.Events);
    }

    [Fact]
    public void Text_is_typed_in_pieces_ending_after_each_tab_or_line_break()
    {
        Assert.Equal(["a\t", "b\n", "c"], CommandProcessor.TypingPieces("a\tb\nc"));
        Assert.Equal(["\t", "\t"], CommandProcessor.TypingPieces("\t\t"));
        Assert.Equal(["plain"], CommandProcessor.TypingPieces("plain"));
    }

    [Fact]
    public async Task A_focus_that_cannot_be_read_is_refused()
    {
        _f.Platform.Desktop.Focused = null;

        var noFocus = await _f.Fails("type", new JsonObject { ["text"] = "x" }, ResultCodes.Refused);
        _f.Platform.Desktop.Focused = new FakeElement { Gone = true };
        var gone = await _f.Fails("type", new JsonObject { ["text"] = "x" }, ResultCodes.Refused);
        var press = await _f.Fails("press", new JsonObject { ["keys"] = new JsonArray("x") }, ResultCodes.Refused);

        Assert.Equal(CommandProcessor.UnknownFocusMessage, noFocus.Error);
        Assert.Equal(CommandProcessor.UnknownFocusMessage, gone.Error);
        Assert.Equal(CommandProcessor.UnknownFocusMessage, press.Error);
        Assert.Empty(_f.Platform.Input.Events);
    }

    [Fact]
    public async Task The_own_window_guard_runs_before_every_key()
    {
        _f.Platform.Input.AfterPress = _ => _f.Platform.Desktop.OwnWindowInFront = true;

        var outcome = await _f.Fails("press", new JsonObject { ["keys"] = new JsonArray("Enter", "Space") }, ResultCodes.Refused);

        Assert.Equal(CommandProcessor.OwnWindowMessage, outcome.Error);
        Assert.Single(_f.Platform.Input.Events);
    }

    [Fact]
    public async Task The_own_window_guard_runs_after_every_tab_while_typing()
    {
        _f.Platform.Input.AfterType = _ => _f.Platform.Desktop.OwnWindowInFront = true;

        var outcome = await _f.Fails("type", new JsonObject { ["text"] = "a\tb" }, ResultCodes.Refused);

        Assert.Equal(CommandProcessor.OwnWindowMessage, outcome.Error);
        Assert.Equal(["type:a\t"], _f.Platform.Input.Events);
    }

    [Theory]
    [InlineData("Control+Alt+End")]
    [InlineData("Control+Alt+Delete")]
    public async Task Ctrl_alt_del_and_its_remote_desktop_form_are_refused(string key)
    {
        await _f.Fails("press", new JsonObject { ["keys"] = new JsonArray(key) }, ResultCodes.Refused);
        Assert.Empty(_f.Platform.Input.Events);
    }

    [Fact]
    public async Task The_clients_own_hotkeys_are_not_pressed()
    {
        _f.Settings = _f.Settings with { StopHotkey = "Ctrl+Alt+F9" };

        var share = await _f.Fails("press", new JsonObject { ["keys"] = new JsonArray("Control+Alt+Shift+a") }, ResultCodes.Refused);
        await _f.Ok("press", new JsonObject { ["keys"] = new JsonArray("Control+Alt+Shift+s") });

        Assert.Contains("own stop or share key", share.Error);
        Assert.Single(_f.Platform.Input.Events);
    }

    [Fact]
    public async Task A_platform_error_answers_failed_and_is_logged()
    {
        _f.Platform.Input.Throw = new System.ComponentModel.Win32Exception(5, "window text that must not leak");

        var outcome = await _f.Fails("type", new JsonObject { ["text"] = "x" }, ResultCodes.Failed);

        Assert.Contains("Win32Exception", outcome.Error);
        Assert.DoesNotContain("must not leak", outcome.Error);
        Assert.Equal("failed", (string?)_f.Log.Read().Single()["code"]);
    }

    [Fact]
    public async Task An_access_error_answers_unavailable()
    {
        _f.Platform.Input.Throw = new UnauthorizedAccessException();

        await _f.Fails("click", new JsonObject { ["x"] = 1, ["y"] = 1 }, ResultCodes.Unavailable);
    }

    [Fact]
    public async Task Typing_into_a_ref_with_Value_is_still_checked_against_the_ref()
    {
        var element = new FakeElement { Password = true };
        _f.Platform.Desktop.Tree = _ => new UiTree([new UiNode(0, "edit", "PIN", null, true, true, true, element)], false);
        await _f.Ok("look", new JsonObject { ["what"] = "window" });

        await _f.Fails("type", new JsonObject { ["text"] = "1234", ["ref"] = "c1" }, ResultCodes.Refused);

        Assert.Empty(element.Calls);
    }
}
