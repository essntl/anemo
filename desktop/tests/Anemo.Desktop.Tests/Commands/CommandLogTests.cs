using System.Text.Json.Nodes;
using Anemo.Desktop.Core.Commands;
using Anemo.Desktop.Core.Storage;
using Anemo.Desktop.Tests.Fakes;

namespace Anemo.Desktop.Tests.Commands;

public sealed class CommandLogTests : IDisposable
{
    private readonly ProcessorFixture _f = new();

    public void Dispose() => _f.Dispose();

    [Fact]
    public async Task Each_command_is_logged_with_its_action_and_outcome()
    {
        await _f.Ok("look", new JsonObject { ["what"] = "screen" });
        await _f.Fails("teleport", null, ResultCodes.Failed);

        var entries = _f.Log.Read();
        Assert.Equal(2, entries.Count);
        Assert.Equal("look", (string?)entries[0]["action"]);
        Assert.Equal("screen", (string?)entries[0]["summary"]);
        Assert.True((bool)entries[0]["ok"]!);
        Assert.Equal("teleport", (string?)entries[1]["action"]);
        Assert.Equal("failed", (string?)entries[1]["code"]);
    }

    [Fact]
    public async Task No_screenshot_typed_text_clipboard_or_command_is_logged()
    {
        _f.Settings = _f.Settings with { PowerShellEnabled = true };
        _f.Platform.Desktop.Focused = _f.Name;
        await _f.Ok("look", new JsonObject { ["what"] = "window" });
        await _f.Ok("type", new JsonObject { ["text"] = "my secret letter" });
        await _f.Ok("clipboard_set", new JsonObject { ["text"] = "clipboard secret" });
        await _f.Ok("press", new JsonObject { ["keys"] = new JsonArray("h", "i", "Control+s") });
        await _f.Ok("open", new JsonObject { ["target"] = "https://example.com/reset?token=sekrit" });
        await _f.Ok("shell", new JsonObject { ["command"] = "Set-Secret -Value hunter2", ["timeout_s"] = 5 }, ProcessorFixture.Trusted);

        var all = string.Join("\n", _f.Log.Read().Select(e => (string?)e["summary"]))
            + string.Join("\n", Directory.GetFiles(_f.LogFolder).Select(File.ReadAllText));
        Assert.DoesNotContain(Convert.ToBase64String(FakeDesktop.Png), all);
        Assert.DoesNotContain("secret letter", all);
        Assert.DoesNotContain("clipboard secret", all);
        Assert.DoesNotContain("hunter2", all);
        Assert.DoesNotContain("sekrit", all);
        Assert.DoesNotContain("Welcome back", all);
        Assert.Contains("16 characters where the focus is", all);
        Assert.Contains("• • Control+s", all);
        Assert.Contains("https://example.com", all);
    }

    [Fact]
    public async Task A_stopped_command_is_logged_as_stopped()
    {
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => _f.Run("type", new JsonObject { ["text"] = "x" }, ct: cts.Token));

        Assert.Equal("stopped", (string?)_f.Log.Read().Single()["code"]);
    }

    [Fact]
    public void Days_older_than_a_week_are_deleted()
    {
        var time = new ManualTime();
        var folder = Path.Combine(Path.GetTempPath(), "anemo-desktop-tests", Guid.NewGuid().ToString("N"));
        try
        {
            var log = new CommandLog(folder, time);
            log.Write("look", "screen", true, null);
            time.Now += TimeSpan.FromDays(3);
            log.Write("look", "window", true, null);
            time.Now += TimeSpan.FromDays(5);
            log.Write("click", "control c1", true, null);

            var entries = log.Read();
            Assert.Equal(["window", "control c1"], entries.Select(e => (string?)e["summary"]));
            Assert.Equal(2, Directory.GetFiles(folder).Length);
        }
        finally
        {
            Directory.Delete(folder, recursive: true);
        }
    }
}
