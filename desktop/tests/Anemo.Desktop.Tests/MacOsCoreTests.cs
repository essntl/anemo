using System.Text.Json.Nodes;
using Anemo.Desktop.Core.CodeJobs;
using Anemo.Desktop.Core.Commands;
using Anemo.Desktop.Core.Control;
using Anemo.Desktop.Core.Platform;
using Anemo.Desktop.Core.Protocol;
using Anemo.Desktop.Core.Storage;
using Anemo.Desktop.Tests.CodeJobs;
using Anemo.Desktop.Tests.Commands;
using Anemo.Desktop.Tests.Fakes;

namespace Anemo.Desktop.Tests;

/// <summary>
/// What Core does for the macOS host (docs/specs/09-desktop-macos.md): points and Retina, the
/// shell, keys, finding programs, Claude Code jobs. Pure code: runs anywhere.
/// </summary>
public sealed class DisplayLayoutTests
{
    // A 13" MacBook Air at its default resolution: 1512×982 points, 3024×1964 pixels.
    private static readonly DisplayInfo Retina = new(1, new ScreenRect(0, 0, 1512, 982), 2.0);

    [Fact]
    public void A_retina_screen_is_shot_in_points_so_a_click_lands_on_the_same_point()
    {
        var plan = DisplayLayout.Plan(DisplayLayout.Union([Retina]));

        Assert.Equal(new CapturePlan(1512, 982, 1.0, 0, 0), plan);
        var capture = new ScreenCapture([], plan.Width, plan.Height, plan.Scale, plan.OriginX, plan.OriginY);
        // The Apple menu at screenshot (20, 11) is at point (20, 11), i.e. pixel (40, 22): CGEvent takes points.
        Assert.Equal(new ScreenPoint(20, 11), ScreenshotScaler.ToScreen(capture, 20, 11));
    }

    [Fact]
    public void A_large_retina_display_is_fitted_to_1568_from_its_points()
    {
        // A 5K display at "looks like 2560×1440": 5120×2880 pixels, 2560×1440 points.
        var studio = new DisplayInfo(2, new ScreenRect(0, 0, 2560, 1440), 2.0);

        var plan = DisplayLayout.Plan(DisplayLayout.Union([studio]));

        Assert.Equal(1568, plan.Width);
        Assert.Equal(882, plan.Height);
        Assert.Equal(2560.0 / 1568, plan.Scale, 6);
        var capture = new ScreenCapture([], plan.Width, plan.Height, plan.Scale, 0, 0);
        Assert.Equal(new ScreenPoint(2560, 1440), ScreenshotScaler.ToScreen(capture, 1568, 882));
        Assert.Equal(new ScreenPoint(1280, 720), ScreenshotScaler.ToScreen(capture, 784, 441));
    }

    [Fact]
    public void A_non_retina_display_maps_the_same_way()
    {
        var hd = new DisplayInfo(3, new ScreenRect(0, 0, 1920, 1080), 1.0);

        var plan = DisplayLayout.Plan(DisplayLayout.Union([hd]));

        Assert.Equal((1568, 882), (plan.Width, plan.Height));
        var capture = new ScreenCapture([], plan.Width, plan.Height, plan.Scale, 0, 0);
        Assert.Equal(new ScreenPoint(960, 540), ScreenshotScaler.ToScreen(capture, 784, 441));
    }

    [Fact]
    public void Displays_left_of_and_above_the_main_one_have_negative_points()
    {
        // An external 1080p display left of the MacBook and a bit higher.
        var external = new DisplayInfo(4, new ScreenRect(-1920, -98, 1920, 1080), 1.0);
        var displays = new[] { Retina, external };

        var union = DisplayLayout.Union(displays);
        var plan = DisplayLayout.Plan(union);

        Assert.Equal(new ScreenRect(-1920, -98, 3432, 1080), union);
        Assert.Equal(1568, plan.Width);
        var capture = new ScreenCapture([], plan.Width, plan.Height, plan.Scale, plan.OriginX, plan.OriginY);
        // The top-left screenshot pixel is the external display's top-left point.
        Assert.Equal(new ScreenPoint(-1920, -98), ScreenshotScaler.ToScreen(capture, 0, 0));
        // The MacBook's top-left corner in the screenshot, and back.
        var macbook = DisplayLayout.Place(plan, Retina.Bounds)!.Value;
        Assert.Equal(new ScreenPoint(0, 0), Near(ScreenshotScaler.ToScreen(capture, macbook.X, macbook.Y), 3));
        Assert.Same(Retina, DisplayLayout.DisplayAt(displays, new ScreenPoint(10, 10)));
        Assert.Same(external, DisplayLayout.DisplayAt(displays, new ScreenPoint(-10, 10)));
        Assert.Null(DisplayLayout.DisplayAt(displays, new ScreenPoint(10, -50))); // above the MacBook: no display
    }

    [Fact]
    public void Each_display_gets_its_place_in_the_stitched_screenshot()
    {
        var above = new DisplayInfo(5, new ScreenRect(0, -1080, 1920, 1080), 1.0);
        var plan = DisplayLayout.Plan(DisplayLayout.Union([Retina, above]));

        var top = DisplayLayout.Place(plan, above.Bounds)!.Value;
        var bottom = DisplayLayout.Place(plan, Retina.Bounds)!.Value;

        Assert.Equal(0, top.Y);
        Assert.Equal(plan.Width, top.Width); // the wider display fills the width
        Assert.InRange(bottom.Y, top.Height - 1, top.Height + 1);
        Assert.Equal(plan.Height, bottom.Y + bottom.Height);
        // CoreGraphics counts y from the bottom: the lower display starts at 0 there.
        Assert.Equal(0, DisplayLayout.FlipY(plan, bottom).Y);
        Assert.Null(DisplayLayout.Place(plan, new ScreenRect(5000, 5000, 10, 10)));
    }

    [Fact]
    public void A_window_is_planned_from_its_own_frame()
    {
        var window = new ScreenRect(-800, 120, 640, 480); // on the external display
        var plan = DisplayLayout.Plan(window);
        var capture = new ScreenCapture([], plan.Width, plan.Height, plan.Scale, plan.OriginX, plan.OriginY);

        Assert.Equal((640, 480, 1.0), (plan.Width, plan.Height, plan.Scale));
        Assert.Equal(new ScreenPoint(-700, 170), ScreenshotScaler.ToScreen(capture, 100, 50));
    }

    private static ScreenPoint Near(ScreenPoint p, int slack)
    {
        Assert.InRange(p.X, -slack, slack);
        Assert.InRange(p.Y, -slack, slack);
        return new ScreenPoint(0, 0);
    }
}

public sealed class MacKeysTests
{
    [Theory]
    [InlineData("Cmd+s", true)]
    [InlineData("Win+s", true)]
    [InlineData("Meta+s", true)]
    public void Cmd_is_a_modifier_on_a_mac_and_the_same_key_as_Win(string text, bool _)
    {
        var combo = KeyParser.Parse(text, mac: true);

        Assert.Equal([KeyParser.VkWin], combo.Modifiers);
        Assert.Equal(MacKeyCodes.FlagCommand, MacKeyCodes.Flags(combo));
        Assert.Equal(MacKeyCodes.Command, MacKeyCodes.ModifierKeyCode(combo.Modifiers[0]));
        Assert.Equal((ushort)0x01, MacKeyCodes.KeyCode(combo.Key)); // kVK_ANSI_S
    }

    [Fact]
    public void Windows_does_not_take_Cmd()
    {
        var e = Assert.Throws<CommandException>(() => KeyParser.Parse("Cmd+s"));
        Assert.Equal(ResultCodes.Failed, e.Code);
    }

    [Theory]
    [InlineData("Cmd+Control+q")]
    [InlineData("Control+Win+q")]
    [InlineData("Cmd+Alt+Escape")]
    public void The_lock_screen_and_force_quit_are_refused_on_a_mac(string text)
    {
        var e = Assert.Throws<CommandException>(() => KeyParser.Parse(text, mac: true));
        Assert.Equal(ResultCodes.Refused, e.Code);
    }

    [Theory]
    [InlineData("Cmd+v", true)] // paste
    [InlineData("Alt+s", true)] // Option+s types ß
    [InlineData("Alt+Shift+2", true)]
    [InlineData("Alt+Space", true)]
    [InlineData("Cmd+a", false)]
    [InlineData("Control+v", true)]
    [InlineData("Enter", false)]
    public void What_types_text_on_a_mac(string text, bool entersText)
    {
        Assert.Equal(entersText, KeyParser.EntersText(KeyParser.Parse(text, mac: true), mac: true));
    }

    [Fact]
    public void On_Windows_Alt_letters_and_Win_v_stay_as_they_were()
    {
        Assert.False(KeyParser.EntersText(KeyParser.Parse("Alt+s")));
        Assert.False(KeyParser.EntersText(KeyParser.Parse("Win+v")));
    }

    [Fact]
    public void Every_named_key_and_letter_has_a_mac_key_code()
    {
        foreach (var name in new[] { "Enter", "Escape", "Tab", "Backspace", "Delete", "Space", "Home", "End", "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight" })
        {
            Assert.NotNull(MacKeyCodes.KeyCode(KeyParser.Parse(name, mac: true).Key));
        }

        var codes = new HashSet<ushort>();
        foreach (var c in "abcdefghijklmnopqrstuvwxyz0123456789")
        {
            var code = MacKeyCodes.KeyCode(KeyParser.Parse(c.ToString(), mac: true).Key);
            Assert.NotNull(code);
            Assert.True(codes.Add(code!.Value), $"{c} shares its key code");
        }
    }

    [Fact]
    public void A_password_field_refuses_Cmd_v_and_Option_letters_on_a_mac()
    {
        using var f = new MacProcessor();
        f.Inner.Platform.Desktop.Focused = f.Inner.Pass;

        foreach (var keys in new[] { "Cmd+v", "Alt+s", "a" })
        {
            var outcome = f.Run("press", new JsonObject { ["keys"] = new JsonArray(keys) });
            Assert.False(outcome.Ok, keys);
            Assert.Equal(ResultCodes.Refused, outcome.Code);
        }

        Assert.Empty(f.Inner.Platform.Input.Events);
    }
}

public sealed class MacShellTests
{
    [Fact]
    public void Zsh_runs_without_startup_files_with_the_command_as_one_argument()
    {
        var start = CommandProcessor.ShellStartFor(ShellProgram.At("/bin/zsh"), "echo \"$HOME\" 'a b'; ls", "/Users/me/AnemoWork");

        Assert.Equal("/bin/zsh", start.FileName);
        Assert.Equal(["-f", "-c", "echo \"$HOME\" 'a b'; ls"], start.Arguments);
        Assert.Equal("/Users/me/AnemoWork", start.WorkingDirectory);
    }

    [Fact]
    public void Bash_runs_without_profile_or_rc()
    {
        var start = CommandProcessor.ShellStartFor(ShellProgram.At("/bin/bash"), "pwd", "/w");

        Assert.Equal(["--noprofile", "--norc", "-c", "pwd"], start.Arguments);
    }

    [Theory]
    [InlineData("/bin/zsh", "zsh")]
    [InlineData("/bin/bash", "bash")]
    [InlineData(@"C:\Program Files\PowerShell\7\pwsh.exe", "pwsh")]
    [InlineData(@"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe", "powershell")]
    public void The_shell_kind_comes_from_the_program(string path, string kind)
    {
        Assert.Equal(kind, ShellProgram.At(path).Kind);
    }

    [Fact]
    public async Task A_mac_runs_its_shell_and_names_it_in_refusals()
    {
        using var f = new MacProcessor();
        f.Inner.Platform.Shell.Program = "/bin/zsh";
        f.Inner.Settings = new DesktopSettings { PowerShellEnabled = true };

        var state = await f.Inner.Ok("shell", new JsonObject { ["command"] = "uname" }, ProcessorFixture.Trusted);

        Assert.Equal(0, (int)state["exit_code"]!);
        Assert.Equal(["-f", "-c", "uname"], f.Inner.Platform.Shell.Started.Single().Arguments);

        var watched = f.Run("shell", new JsonObject { ["command"] = "uname" }, ProcessorFixture.Watched);
        Assert.Equal("The shell is only for trusted devices, and this one is watched.", watched.Error);
        f.Inner.Platform.Shell.Program = null;
        var none = f.Run("shell", new JsonObject { ["command"] = "uname" }, ProcessorFixture.Trusted);
        Assert.Equal("Neither zsh nor bash was found on this Mac.", none.Error);
    }

    [Fact]
    public void The_mac_secure_screen_message_says_unlock()
    {
        using var f = new MacProcessor();
        f.Inner.Platform.Desktop.Secure = true;

        var outcome = f.Run("look", new JsonObject { ["what"] = "screen" });

        Assert.Equal(DesktopPlatform.MacOS("/Users/me").SecureScreenMessage, outcome.Error);
    }
}

public sealed class PosixPathTests
{
    [Fact]
    public void The_path_puts_the_users_tools_first_and_drops_relative_folders()
    {
        var path = PosixPath.Augmented("/usr/bin:/bin:.::bin:/usr/sbin:/sbin", "/Users/me/", ["/usr/local/bin", "/System/Cryptexes/App/usr/bin"]);

        Assert.Equal(
            "/Users/me/.local/bin:/Users/me/.claude/local:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/System/Cryptexes/App/usr/bin",
            path);
    }

    [Fact]
    public void A_program_is_found_only_in_absolute_folders()
    {
        var exists = new HashSet<string> { "./claude", "/Users/me/.local/bin/claude", "/opt/homebrew/bin/gh" };

        Assert.Equal("/Users/me/.local/bin/claude", PosixPath.Find("claude", ".:/Users/me/.local/bin", exists.Contains));
        Assert.Equal("/opt/homebrew/bin/gh", PosixPath.Find("gh", "/usr/bin:/opt/homebrew/bin/", exists.Contains));
        Assert.Null(PosixPath.Find("claude", ".:bin", exists.Contains));
        Assert.Null(PosixPath.Find("../claude", "/x", _ => true));
        Assert.Null(PosixPath.Find("", "/x", _ => true));
    }
}

public sealed class MacCodeJobTests : IDisposable
{
    private static readonly DeviceInfo Trusted = new("dev-1", "Mac", "computer", "trusted");
    private readonly JobsFolder _jobs = new();
    private readonly FakeCodeHost _host = new();

    public void Dispose() => _jobs.Dispose();

    [Fact]
    public void The_mac_defaults_are_in_the_home_folder()
    {
        var mac = DesktopPlatform.MacOS("/Users/olena");

        Assert.Equal("/Users/olena/anemo-bridge/jobs", mac.DefaultJobsFolder);
        Assert.Equal("/Users/olena/dev", mac.DefaultProjectsFolder);
        Assert.Equal("macos", mac.WireName);
        Assert.False(mac.JobsThroughCmdExe);
        Assert.Equal(@"C:\anemo-bridge\jobs", DesktopPlatform.Windows.DefaultJobsFolder);
        Assert.Equal(@"C:\dev", DesktopPlatform.Windows.DefaultProjectsFolder);
    }

    [Fact]
    public async Task A_job_on_a_mac_is_described_without_any_shell_and_its_paths_may_hold_a_percent()
    {
        // A folder name with % can't go through cmd.exe, but a Mac starts the job
        // with posix_spawn and the files as stdin/stdout/stderr: nothing is quoted.
        var jobs = Path.Combine(_jobs.Root, "100% jobs");
        var projects = Path.Combine(_jobs.Root, "dev");
        Directory.CreateDirectory(Path.Combine(projects, "anemo"));
        _host.OnPath["claude"] = "/Users/me/.local/bin/claude";
        var settings = new DesktopSettings { ShareCodeJobs = true, StartCodeJobs = true, CodeJobsFolder = jobs, CodeProjectsFolder = projects };
        var time = new ManualTime();
        var control = new CodeJobControl(() => settings, _host, new FakeProcesses(), time, new CodeJobControlOptions { NewIdSuffix = () => "m4c0" }, DesktopPlatform.MacOS("/Users/me"));
        var processor = new CommandProcessor(new FakePlatform().Services, new ControlState(time, true, null), () => settings, null, new CommandOptions { Platform = DesktopPlatform.MacOS("/Users/me") }, control);

        var outcome = await processor.ExecuteAsync(
            new JsonObject { ["type"] = "device.command", ["id"] = "1", ["action"] = "code_start", ["project"] = "anemo", ["prompt"] = "Fix it", ["model"] = "opus", ["max_turns"] = 5 },
            Trusted,
            CancellationToken.None);

        Assert.True(outcome.Ok, outcome.Error);
        var launch = Assert.Single(_host.Launches);
        Assert.Equal("/Users/me/.local/bin/claude", launch.Claude);
        Assert.Equal(Path.Combine(projects, "anemo"), launch.WorkingDirectory);
        Assert.StartsWith(jobs, launch.JobFolder);
        Assert.Equal(
            ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions", "--model", "opus", "--max-turns", "5"],
            launch.Arguments);
        Assert.Equal(Path.Combine(launch.JobFolder, "prompt.txt"), launch.PromptPath);
        Assert.Equal("Fix it", File.ReadAllText(launch.PromptPath));
    }

    [Fact]
    public async Task A_mac_says_macOS_when_it_couldnt_start_the_job()
    {
        var projects = Path.Combine(_jobs.Root, "dev");
        Directory.CreateDirectory(Path.Combine(projects, "anemo"));
        _host.OnPath["claude"] = "/opt/homebrew/bin/claude";
        _host.NextPid = null;
        var settings = new DesktopSettings { ShareCodeJobs = true, StartCodeJobs = true, CodeJobsFolder = _jobs.Jobs, CodeProjectsFolder = projects };
        var time = new ManualTime();
        var control = new CodeJobControl(() => settings, _host, new FakeProcesses(), time, null, DesktopPlatform.MacOS("/Users/me"));
        var processor = new CommandProcessor(new FakePlatform().Services, new ControlState(time, true, null), () => settings, null, null, control);

        var outcome = await processor.ExecuteAsync(
            new JsonObject { ["type"] = "device.command", ["id"] = "1", ["action"] = "code_start", ["project"] = "anemo", ["prompt"] = "x" },
            Trusted,
            CancellationToken.None);

        Assert.False(outcome.Ok);
        Assert.StartsWith("macOS couldn't start the job", outcome.Error);
    }

    [Fact]
    public void The_windows_start_of_a_launch_is_the_cmd_line_as_before()
    {
        var launch = new JobLaunch(@"C:\c\claude.exe", @"C:\j\20261124-100000-abcd", @"C:\dev\x", "s-1", null, 3);

        var start = WindowsJobCommand.For(launch);

        Assert.Equal("cmd.exe", start.FileName);
        Assert.Equal(@"C:\dev\x", start.WorkingDirectory);
        Assert.Equal(CodeJobControl.CommandLine(launch.Claude, launch.JobFolder, "s-1", null, 3), start.CommandLine);
        Assert.Same(CodeJobControl.StartEnvironment, start.Environment);
    }
}

/// <summary>The processor fixture with the macOS platform.</summary>
internal sealed class MacProcessor : IDisposable
{
    public MacProcessor()
    {
        Inner = new ProcessorFixture(DesktopPlatform.MacOS("/Users/me"));
    }

    public ProcessorFixture Inner { get; }

    public CommandOutcome Run(string action, JsonObject fields, DeviceInfo? device = null) =>
        Inner.Run(action, fields, device).GetAwaiter().GetResult();

    public void Dispose() => Inner.Dispose();
}
