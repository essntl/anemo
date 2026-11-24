using System.Diagnostics;
using Anemo.Desktop.Core.CodeJobs;
using Anemo.Desktop.Core.Commands;
using Anemo.Desktop.Core.Platform;
using Anemo.Desktop.Mac.Native;
using Anemo.Desktop.Mac.Platform;

namespace Anemo.Desktop.Mac.Tests;

/// <summary>A test that only means something on macOS; skipped elsewhere.</summary>
public sealed class MacFactAttribute : FactAttribute
{
    public MacFactAttribute()
    {
        if (!OperatingSystem.IsMacOS())
        {
            Skip = "Needs macOS (runs in CI's macOS job).";
        }
    }
}

/// <summary>
/// The native calls of the Mac host, for real (docs/specs/09-desktop-macos.md §7). A hosted CI
/// runner has no Screen Recording or Accessibility permission, so screenshots, the
/// Accessibility tree and input are not tested here: see 09-desktop-macos-mac-testing.md.
/// </summary>
[System.Runtime.Versioning.SupportedOSPlatform("macos")] // skipped elsewhere (MacFact)
public sealed class MacSmokeTests
{
    [MacFact]
    public void The_frameworks_and_classes_the_app_uses_are_there()
    {
        foreach (var name in new[] { "NSWorkspace", "NSPasteboard", "NSRunningApplication", "SCShareableContent", "SCScreenshotManager", "SCContentFilter", "SCStreamConfiguration", "SMAppService" })
        {
            Assert.NotEqual(0, ObjC.Class(name));
        }

        // Checking a permission never asks and never throws.
        _ = Permissions.ScreenRecording;
        _ = Permissions.Accessibility;
        _ = LoginItem.IsOn;
    }

    [MacFact]
    public void The_displays_are_read_in_points()
    {
        var displays = ScreenCapturer.Displays();

        Assert.NotEmpty(displays);
        var main = displays.Single(d => d.Id == CG.MainDisplay());
        Assert.Equal(0, main.Bounds.X);
        Assert.Equal(0, main.Bounds.Y);
        Assert.True(main.Bounds.Width > 0 && main.Bounds.Height > 0);
        Assert.InRange(main.PixelsPerUnit, 1.0, 3.0);
        var plan = DisplayLayout.Plan(DisplayLayout.Union(displays));
        Assert.InRange(Math.Max(plan.Width, plan.Height), 1, ScreenshotScaler.MaxSide);
    }

    [MacFact]
    public void The_window_list_and_the_lock_check_read_without_failing()
    {
        var desktop = new MacDesktop();

        _ = desktop.IsSecureDesktop();
        _ = desktop.ListWindows();
        _ = desktop.FrontWindow();
        Assert.False(desktop.IsOwnWindowInFront());
    }

    [MacFact]
    public void A_hand_built_block_is_called_by_Objective_C()
    {
        // NSOperationQueue copies and runs a block like ScreenCaptureKit's completion handlers
        // do, without needing any permission (CI has none).
        var done = new ManualResetEventSlim();
        var block = Blocks.TwoArgs((_, _) => done.Set());
        var queue = ObjC.Call(ObjC.Call(ObjC.Class("NSOperationQueue"), "alloc"), "init");
        ObjC.SendVoid(queue, ObjC.Selector("addOperationWithBlock:"), block);

        Assert.True(done.Wait(TimeSpan.FromSeconds(10)), "the block wasn't called");
        ObjC.Call(queue, "release");
    }

    [MacFact]
    public void With_Screen_Recording_the_screen_is_captured()
    {
        if (!Permissions.ScreenRecording)
        {
            return; // a hosted runner never has it; on a Mac with it, this runs
        }

        var capture = ScreenCapturer.CaptureScreen();

        Assert.True(capture.Png.Length > 1000);
        Assert.Equal(0x89, capture.Png[0]); // PNG signature
        Assert.InRange(Math.Max(capture.Width, capture.Height), 1, ScreenshotScaler.MaxSide);
    }

    [MacFact]
    public async Task Zsh_runs_a_command_without_startup_files()
    {
        var shell = new MacShellHost();
        var program = shell.FindShell();
        Assert.NotNull(program);
        Assert.Equal(ShellKinds.Zsh, program!.Kind);

        var lines = new List<string>();
        var start = CommandProcessor.ShellStartFor(program, "print -r -- \"$ZSH_NAME:$((6*7))\"; echo $PATH", Path.GetTempPath());
        var exit = await shell.RunAsync(start, lines.Add, _ => { }, CancellationToken.None);

        Assert.Equal(0, exit);
        Assert.Equal("zsh:42", lines[0]);
        Assert.Contains("/opt/homebrew/bin", lines[1]);
    }

    [MacFact]
    public void Programs_are_found_on_the_augmented_path()
    {
        Assert.Equal("/bin/sh", MacEnvironment.Find("sh"));
        Assert.Null(MacEnvironment.Find("../sh"));
    }

    [MacFact]
    public void A_job_is_spawned_with_its_files_in_its_own_process_group_and_the_group_is_ended()
    {
        var folder = Directory.CreateTempSubdirectory("anemo-mac-job-").FullName;
        try
        {
            var prompt = Path.Combine(folder, "prompt.txt");
            File.WriteAllText(prompt, "hello from the prompt");
            var spawn = new Posix.Spawn(
                "/bin/sh",
                // cat copies stdin to out.jsonl; the background sleep is a grandchild the group kill must end.
                ["-c", "cat; echo oops >&2; sleep 120 & echo $! > child.pid; wait"],
                folder,
                prompt,
                Path.Combine(folder, "out.jsonl"),
                Path.Combine(folder, "err.txt"),
                MacEnvironment.ForChildren());

            var pid = Posix.SpawnDetached(spawn);

            Assert.True(SpinWait.SpinUntil(() => File.Exists(Path.Combine(folder, "child.pid")) && File.ReadAllText(Path.Combine(folder, "child.pid")).Trim().Length > 0, 10_000));
            Assert.Equal(pid, Posix.GetPgid(pid)); // it leads its own group
            Assert.NotEqual(Posix.GetPgid(Environment.ProcessId), pid);
            Assert.Equal("hello from the prompt", File.ReadAllText(Path.Combine(folder, "out.jsonl")));
            Assert.Equal("oops\n", File.ReadAllText(Path.Combine(folder, "err.txt")));
            var child = int.Parse(File.ReadAllText(Path.Combine(folder, "child.pid")).Trim());
            Assert.Equal(pid, Posix.GetPgid(child));
            Assert.NotNull(new MacProcessProbe().Find(pid)?.StartedAt);

            Assert.True(new MacCodeHost().KillTree(pid));

            Assert.True(SpinWait.SpinUntil(() => !Posix.GroupAlive(pid), 10_000), "the job's group is still there");
            Assert.True(SpinWait.SpinUntil(() => new MacProcessProbe().Find(pid) is null, 10_000), "the job was left a zombie");
        }
        finally
        {
            Directory.Delete(folder, recursive: true);
        }
    }

    [MacFact]
    public void The_job_spawn_is_claude_itself_with_the_files_as_its_stdio()
    {
        var launch = new JobLaunch("/Users/me/.local/bin/claude", "/Users/me/anemo-bridge/jobs/20261124-100000-abcd", "/Users/me/dev/x", null, "opus", null);

        var spawn = MacCodeHost.SpawnFor(launch, new Dictionary<string, string> { ["PATH"] = "/usr/bin" });

        Assert.Equal("/Users/me/.local/bin/claude", spawn.Program);
        Assert.Equal(launch.Arguments, spawn.Arguments);
        Assert.Equal("/Users/me/anemo-bridge/jobs/20261124-100000-abcd/prompt.txt", spawn.StdinPath);
        Assert.Equal("/Users/me/anemo-bridge/jobs/20261124-100000-abcd/out.jsonl", spawn.StdoutPath);
        Assert.Equal("/Users/me/anemo-bridge/jobs/20261124-100000-abcd/err.txt", spawn.StderrPath);
        Assert.Equal("/Users/me/dev/x", spawn.WorkingDirectory);
    }

    [MacFact]
    public void The_token_goes_to_the_keychain_and_only_a_marker_to_the_file()
    {
        var service = "Anemo Desktop tests " + Guid.NewGuid().ToString("N");
        var protector = new KeychainTokenProtector(service);
        string marker;
        try
        {
            marker = protector.Protect("anemo_secret_1");
        }
        catch (InvalidOperationException e) when (e.Message.Contains("-25308") || e.Message.Contains("-25294") || e.Message.Contains("-25291"))
        {
            return; // a runner without an unlocked login keychain: nothing to test there
        }

        try
        {
            Assert.Equal(KeychainTokenProtector.Marker, marker);
            Assert.Equal("anemo_secret_1", protector.Unprotect(marker));
            protector.Protect("anemo_secret_2"); // replaces it
            Assert.Equal("anemo_secret_2", protector.Unprotect(marker));
            Assert.Null(protector.Unprotect("protected:something-else"));
        }
        finally
        {
            Keychain.Delete(service, KeychainTokenProtector.Account);
        }

        Assert.Null(protector.Unprotect(marker));
    }

    [MacFact]
    public void The_clipboard_takes_text()
    {
        new MacClipboard().SetText("anemo clipboard test");

        var paste = Process.Start(new ProcessStartInfo("/usr/bin/pbpaste") { RedirectStandardOutput = true, UseShellExecute = false })!;
        var text = paste.StandardOutput.ReadToEnd();
        paste.WaitForExit();

        Assert.Equal("anemo clipboard test", text);
    }

    [MacFact]
    public void The_applications_are_listed()
    {
        var apps = new MacApps().ListApps();

        Assert.Contains(apps, a => a.Name == "Safari" || a.Name == "TextEdit");
        Assert.All(apps, a => Assert.EndsWith(".app", a.LaunchId));
    }
}
