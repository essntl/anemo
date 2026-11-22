using System.Text;
using System.Text.Json.Nodes;
using Anemo.Desktop.Core.Commands;

namespace Anemo.Desktop.Tests.Commands;

public sealed class ShellTests : IDisposable
{
    private readonly ProcessorFixture _f = new();

    public ShellTests() => _f.Settings = _f.Settings with { PowerShellEnabled = true };

    public void Dispose() => _f.Dispose();

    private static JsonObject Command(string command = "Get-Date", int timeout = 30) =>
        new() { ["command"] = command, ["timeout_s"] = timeout };

    [Fact]
    public async Task Runs_PowerShell_without_profile_or_prompts_in_the_work_folder()
    {
        var state = await _f.Ok("shell", Command("Get-ChildItem | Select -First 3"), ProcessorFixture.Trusted);

        var start = Assert.Single(_f.Platform.Shell.Started);
        Assert.Equal(@"C:\Program Files\PowerShell\7\pwsh.exe", start.FileName);
        Assert.Equal(["-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand"], start.Arguments.Take(5));
        var script = Encoding.Unicode.GetString(Convert.FromBase64String(start.Arguments[5]));
        Assert.EndsWith("Get-ChildItem | Select -First 3", script);
        Assert.Equal(@"C:\Users\me\AnemoWork", start.WorkingDirectory);
        Assert.Equal([@"C:\Users\me\AnemoWork"], _f.Platform.Shell.Folders);

        Assert.Equal(0, (int)state["exit_code"]!);
        Assert.Equal("hello\n", (string?)state["stdout"]);
        Assert.Equal("", (string?)state["stderr"]);
        Assert.False((bool)state["truncated"]!);
        Assert.True((long)state["duration_ms"]! >= 0);
        Assert.Null(state["screenshot"]);
    }

    [Fact]
    public async Task The_work_folder_from_the_settings_is_used()
    {
        _f.Settings = _f.Settings with { WorkFolder = @"D:\Work" };

        await _f.Ok("shell", Command(), ProcessorFixture.Trusted);

        Assert.Equal(@"D:\Work", _f.Platform.Shell.Started.Single().WorkingDirectory);
    }

    [Fact]
    public async Task Exit_code_and_errors_come_back()
    {
        _f.Platform.Shell.Behaviour = (_, stderr, _) =>
        {
            stderr("Access denied");
            return Task.FromResult(1);
        };

        var state = await _f.Ok("shell", Command(), ProcessorFixture.Trusted);

        Assert.Equal(1, (int)state["exit_code"]!);
        Assert.Equal("Access denied\n", (string?)state["stderr"]);
    }

    [Fact]
    public async Task Long_output_keeps_head_and_tail()
    {
        _f.Platform.Shell.Behaviour = (stdout, _, _) =>
        {
            for (var i = 0; i < 5000; i++)
            {
                stdout($"line {i:D5}");
            }

            return Task.FromResult(0);
        };

        var state = await _f.Ok("shell", Command(), ProcessorFixture.Trusted);

        var stdout = (string)state["stdout"]!;
        Assert.True((bool)state["truncated"]!);
        Assert.StartsWith("line 00000\n", stdout);
        Assert.EndsWith("line 04999\n", stdout);
        Assert.Contains("characters cut", stdout);
        Assert.True(stdout.Length < OutputCapture.Head + OutputCapture.Tail + 100);
    }

    [Fact]
    public async Task A_command_past_its_timeout_is_stopped()
    {
        _f.Platform.Shell.Behaviour = async (_, _, ct) =>
        {
            await Task.Delay(Timeout.Infinite, ct);
            return 0;
        };

        var outcome = await _f.Fails("shell", Command(timeout: 1), ResultCodes.Failed, ProcessorFixture.Trusted);

        Assert.Contains("1 seconds", outcome.Error);
    }

    [Fact]
    public async Task The_stop_hotkey_cancels_the_command()
    {
        using var cts = new CancellationTokenSource();
        _f.Platform.Shell.Behaviour = async (_, _, ct) =>
        {
            cts.Cancel();
            await Task.Delay(Timeout.Infinite, ct);
            return 0;
        };

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => _f.Run("shell", Command(), ProcessorFixture.Trusted, cts.Token));
    }

    [Fact]
    public async Task Refused_on_a_watched_device()
    {
        var outcome = await _f.Fails("shell", Command(), ResultCodes.Refused, ProcessorFixture.Watched);

        Assert.Contains("trusted", outcome.Error);
        Assert.Empty(_f.Platform.Shell.Started);
    }

    [Fact]
    public async Task Refused_when_PowerShell_is_switched_off_in_the_client()
    {
        _f.Settings = _f.Settings with { PowerShellEnabled = false };

        var outcome = await _f.Fails("shell", Command(), ResultCodes.Refused, ProcessorFixture.Trusted);

        Assert.Contains("switched off", outcome.Error);
        Assert.Empty(_f.Platform.Shell.Started);
    }

    [Fact]
    public async Task Refused_when_control_is_off()
    {
        _f.Control.SetAllow(false);

        await _f.Fails("shell", Command(), ResultCodes.Refused, ProcessorFixture.Trusted);

        Assert.Empty(_f.Platform.Shell.Started);
    }

    [Fact]
    public async Task Unavailable_without_PowerShell()
    {
        _f.Platform.Shell.Program = null;

        await _f.Fails("shell", Command(), ResultCodes.Unavailable, ProcessorFixture.Trusted);
    }

    [Fact]
    public async Task Checks_the_command_and_timeout()
    {
        await _f.Fails("shell", Command(new string('a', 8001)), ResultCodes.Failed, ProcessorFixture.Trusted);
        await _f.Fails("shell", Command(timeout: 601), ResultCodes.Failed, ProcessorFixture.Trusted);
        await _f.Fails("shell", Command(timeout: 0), ResultCodes.Failed, ProcessorFixture.Trusted);
        Assert.Empty(_f.Platform.Shell.Started);
    }

    [Fact]
    public void The_command_is_passed_encoded_so_quotes_cannot_change_it()
    {
        var start = CommandProcessor.ShellStartFor("powershell.exe", "Write-Output \"a\" ; 'b' `\"", @"C:\W");

        Assert.Equal(6, start.Arguments.Count);
        var script = Encoding.Unicode.GetString(Convert.FromBase64String(start.Arguments[5]));
        Assert.Equal(CommandProcessor.ShellPrelude + "Write-Output \"a\" ; 'b' `\"", script);
    }
}
