using System.Text.Json.Nodes;
using Anemo.Desktop.Core.Commands;
using Anemo.Desktop.Core.Platform;
using Anemo.Desktop.Tests.Fakes;

namespace Anemo.Desktop.Tests.Commands;

public sealed class LookTests : IDisposable
{
    private readonly ProcessorFixture _f = new();

    public void Dispose() => _f.Dispose();

    [Fact]
    public async Task Look_at_the_window_gives_the_whole_state()
    {
        var state = await _f.Ok("look", new JsonObject { ["what"] = "window" });

        Assert.Equal("w1", (string?)state["window"]!["ref"]);
        Assert.Equal("Book1 - Excel", (string?)state["window"]!["title"]);
        Assert.Equal("EXCEL.EXE", (string?)state["window"]!["app"]);
        Assert.Equal(Convert.ToBase64String(FakeDesktop.Png), (string?)state["screenshot"]);
        Assert.Equal(2.0, (double)state["scale"]!);
        Assert.False((bool)state["truncated"]!);
        Assert.Contains("capture_window:1001", _f.Platform.Desktop.Calls);

        var controls = state["controls"]!.AsArray();
        Assert.Equal(3, controls.Count);
        Assert.Equal("c1", (string?)controls[0]!["ref"]);
        Assert.Equal("button", (string?)controls[0]!["role"]);
        Assert.Equal("Save", (string?)controls[0]!["name"]);
        Assert.True((bool)controls[0]!["enabled"]!);
        Assert.False((bool)controls[0]!["password"]!);
        Assert.Equal("Ada", (string?)controls[1]!["value"]);

        var text = (string)state["text"]!;
        Assert.Contains("[c1] button \"Save\"", text);
        Assert.Contains("text \"Welcome back\"", text);
    }

    [Fact]
    public async Task A_password_control_never_shows_its_value()
    {
        var state = await _f.Ok("look", new JsonObject { ["what"] = "window" });

        var pass = state["controls"]!.AsArray()[2]!;
        Assert.True((bool)pass["password"]!);
        Assert.Null(pass["value"]);
        Assert.DoesNotContain("hunter2", state.ToJsonString());
    }

    [Fact]
    public async Task Look_at_the_screen_captures_every_monitor_and_reads_the_front_window()
    {
        var state = await _f.Ok("look", new JsonObject { ["what"] = "screen" });

        Assert.Contains("capture_screen", _f.Platform.Desktop.Calls);
        Assert.Equal("Book1 - Excel", (string?)state["window"]!["title"]);
        Assert.Equal(3, state["controls"]!.AsArray().Count);
    }

    [Fact]
    public async Task Windows_lists_the_open_windows_without_a_screenshot()
    {
        var state = await _f.Ok("look", new JsonObject { ["what"] = "windows" });

        var windows = state["windows"]!.AsArray();
        Assert.Equal(3, windows.Count);
        Assert.Equal("w1", (string?)windows[0]!["ref"]);
        Assert.Equal("Downloads", (string?)windows[2]!["title"]);
        Assert.True((bool)windows[2]!["minimized"]!);
        Assert.Null(state["screenshot"]);
        Assert.DoesNotContain(_f.Platform.Desktop.Calls, c => c.StartsWith("capture", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_window_ref_from_the_list_can_be_looked_at()
    {
        await _f.Ok("look", new JsonObject { ["what"] = "windows" });

        var state = await _f.Ok("look", new JsonObject { ["what"] = "window", ["window_ref"] = "w2" });

        Assert.Equal("Notes - Notepad", (string?)state["window"]!["title"]);
        Assert.Contains("capture_window:1002", _f.Platform.Desktop.Calls);
    }

    [Fact]
    public async Task A_closed_window_answers_failed()
    {
        await _f.Ok("look", new JsonObject { ["what"] = "windows" });
        _f.Platform.Desktop.Windows.RemoveAt(1);

        var outcome = await _f.Fails("look", new JsonObject { ["what"] = "window", ["window_ref"] = "w2" }, ResultCodes.Failed);

        Assert.Equal("That window is gone; look again", outcome.Error);
    }

    [Fact]
    public async Task A_minimized_window_is_not_brought_up_by_a_look()
    {
        await _f.Ok("look", new JsonObject { ["what"] = "windows" });

        var outcome = await _f.Fails("look", new JsonObject { ["what"] = "window", ["window_ref"] = "w3" }, ResultCodes.Failed);

        Assert.Contains("focus_window", outcome.Error);
        Assert.DoesNotContain(_f.Platform.Desktop.Calls, c => c.StartsWith("focus_window", StringComparison.Ordinal));
    }

    [Fact]
    public async Task At_most_300_controls_get_refs_and_the_rest_is_marked_truncated()
    {
        var nodes = Enumerable.Range(0, 450)
            .Select(i => new UiNode(1, "button", $"B{i}", null, true, false, true, new FakeElement()))
            .ToList();
        _f.Platform.Desktop.Tree = _ => new UiTree(nodes, false);

        var state = await _f.Ok("look", new JsonObject { ["what"] = "window" });

        Assert.Equal(300, state["controls"]!.AsArray().Count);
        Assert.Equal("c300", (string?)state["controls"]!.AsArray()[299]!["ref"]);
        Assert.True((bool)state["truncated"]!);
        Assert.NotNull(state["note"]);
    }

    [Fact]
    public async Task The_text_stays_under_40000_characters()
    {
        var nodes = Enumerable.Range(0, 2000)
            .Select(i => new UiNode(1, "text", new string('x', 100) + i, null, true, false, false, null))
            .ToList();
        _f.Platform.Desktop.Tree = _ => new UiTree(nodes, false);

        var state = await _f.Ok("look", new JsonObject { ["what"] = "window" });

        Assert.True(((string)state["text"]!).Length <= 40_000);
        Assert.True((bool)state["truncated"]!);
    }

    [Fact]
    public async Task A_cut_short_tree_walk_is_marked_truncated()
    {
        _f.Platform.Desktop.Tree = _ => new UiTree([new UiNode(0, "button", "OK", null, true, false, true, new FakeElement())], true);

        var state = await _f.Ok("look", new JsonObject { ["what"] = "window" });

        Assert.True((bool)state["truncated"]!);
    }

    [Fact]
    public async Task Looking_works_while_control_is_off()
    {
        _f.Control.SetAllow(false);

        await _f.Ok("look", new JsonObject { ["what"] = "screen" });
    }

    [Fact]
    public async Task On_the_secure_desktop_nothing_is_tried()
    {
        _f.Platform.Desktop.Secure = true;

        var outcome = await _f.Fails("look", new JsonObject { ["what"] = "screen" }, ResultCodes.Unavailable);

        Assert.Contains("secure", outcome.Error);
        Assert.Empty(_f.Platform.Desktop.Calls);
    }

    [Fact]
    public async Task An_unknown_what_fails()
    {
        await _f.Fails("look", new JsonObject { ["what"] = "everything" }, ResultCodes.Failed);
    }

    [Fact]
    public async Task An_unknown_action_fails_with_its_name()
    {
        var outcome = await _f.Fails("teleport", null, ResultCodes.Failed);

        Assert.Equal("Unknown action “teleport”", outcome.Error);
    }

    [Fact]
    public async Task An_unknown_action_fails_even_while_control_is_off()
    {
        _f.Control.SetAllow(false);

        var outcome = await _f.Fails("teleport", null, ResultCodes.Failed);

        Assert.Equal("Unknown action “teleport”", outcome.Error);
    }
}
