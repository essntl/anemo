using Anemo.Desktop.Tests.Fakes;
using Anemo.Desktop.Core.Updates;

namespace Anemo.Desktop.Tests.Updates;

/// <summary>The swap and the restart's watch, on a fake file system.</summary>
public sealed class UpdateSwapTests
{
    private const string Current = @"C:\Apps\Anemo Desktop.exe";
    private const string Staged = @"C:\Apps\Anemo Desktop.new.exe";
    private const string Previous = @"C:\Apps\Anemo Desktop.old.exe";
    private const string Folder = @"C:\Data\updates";
    private static readonly StagedUpdate Update = new(new AppVersion(1, 9, 0), new UpdatePaths(Current, Staged, Previous));

    private readonly FakeUpdateFiles _files = new();
    private readonly FakeLauncher _launcher = new();
    private readonly ListLog _log = new();

    public UpdateSwapTests()
    {
        _files.Items[Current] = "1.8.0";
        _files.Items[Staged] = "1.9.0";
    }

    private UpdateInstaller Installer => new(_files, _launcher, _log, Folder)
    {
        StartWatch = TimeSpan.FromMilliseconds(300),
        WatchStep = TimeSpan.FromMilliseconds(10),
    };

    [Fact]
    public void Installing_at_quit_swaps_the_new_version_in_and_keeps_the_old_one()
    {
        _files.Items[Previous] = "1.7.0"; // the backup of the update before

        Assert.Equal(InstallOutcome.Installed, Installer.InstallOnQuit(Update));

        Assert.Equal("1.9.0", _files.Items[Current]);
        Assert.Equal("1.8.0", _files.Items[Previous]);
        Assert.False(_files.Exists(Staged));
        Assert.Empty(_launcher.Started); // nothing starts at quit
    }

    [Fact]
    public void When_the_running_version_cannot_be_moved_aside_nothing_changes()
    {
        _files.FailingMoves.Add($"{Current}→{Previous}");

        Assert.Equal(InstallOutcome.NotInstalled, Installer.InstallOnQuit(Update));

        Assert.Equal("1.8.0", _files.Items[Current]);
        Assert.Equal("1.9.0", _files.Items[Staged]);
    }

    [Fact]
    public void When_the_new_version_cannot_be_moved_in_the_old_one_goes_back()
    {
        _files.FailingMoves.Add($"{Staged}→{Current}");

        Assert.Equal(InstallOutcome.NotInstalled, Installer.InstallOnQuit(Update));

        Assert.Equal("1.8.0", _files.Items[Current]);
        Assert.False(_files.Exists(Previous));
    }

    [Fact]
    public void When_even_going_back_fails_the_log_says_where_the_old_version_is()
    {
        _files.FailingMoves.Add($"{Staged}→{Current}");
        _files.FailingMoves.Add($"{Previous}→{Current}");

        Assert.Equal(InstallOutcome.Broken, Installer.InstallOnQuit(Update));

        Assert.Equal("1.8.0", _files.Items[Previous]);
        Assert.Contains(_log.Lines, l => l.Contains("BROKEN") && l.Contains(Previous));
    }

    [Fact]
    public void A_staged_version_that_is_gone_is_not_installed()
    {
        _files.Items.Remove(Staged);

        Assert.Equal(InstallOutcome.NotInstalled, Installer.InstallOnQuit(Update));
        Assert.Equal("1.8.0", _files.Items[Current]);
    }

    [Fact]
    public async Task A_restart_starts_the_new_version_which_says_it_is_up()
    {
        var installer = Installer;
        _launcher.OnStart = (_, _) =>
        {
            installer.ReportStarted(Update.Version); // what the new copy does with --updated
            return new FakeProcess();
        };

        Assert.Equal(InstallOutcome.Installed, await installer.InstallAndRestartAsync(Update));

        Assert.Equal([(Current, UpdateInstaller.UpdatedArgument)], _launcher.Started);
        Assert.Equal("1.9.0", _files.Items[Current]);
        Assert.Null(installer.FailedVersion());
    }

    [Fact]
    public async Task A_new_version_that_exits_at_once_is_replaced_by_the_old_one_which_starts_again()
    {
        _launcher.OnStart = (_, argument) => argument is null ? new FakeProcess() : new FakeProcess { HasExited = true };
        var installer = Installer;

        Assert.Equal(InstallOutcome.RolledBack, await installer.InstallAndRestartAsync(Update));

        Assert.Equal("1.8.0", _files.Items[Current]);
        Assert.False(_files.Exists(Previous));
        Assert.Equal([(Current, UpdateInstaller.UpdatedArgument), (Current, null)], _launcher.Started);
        Assert.Equal(Update.Version, installer.FailedVersion()); // not downloaded again by itself
    }

    [Fact]
    public async Task A_new_version_that_hangs_silently_is_ended_and_rolled_back()
    {
        var hung = new FakeProcess();
        _launcher.OnStart = (_, argument) => argument is null ? new FakeProcess() : hung;

        Assert.Equal(InstallOutcome.RolledBack, await Installer.InstallAndRestartAsync(Update));

        Assert.True(hung.Killed);
        Assert.Equal("1.8.0", _files.Items[Current]);
    }

    [Fact]
    public async Task Going_back_retries_while_the_ended_exe_is_still_locked()
    {
        _launcher.OnStart = (_, argument) => argument is null ? new FakeProcess() : new FakeProcess { HasExited = true };
        _files.FailingDeletes[Current] = 3;

        Assert.Equal(InstallOutcome.RolledBack, await Installer.InstallAndRestartAsync(Update));
        Assert.Equal("1.8.0", _files.Items[Current]);
    }

    [Fact]
    public async Task A_stale_started_file_from_an_earlier_update_does_not_count()
    {
        var installer = Installer;
        _files.Items[installer.StartedFile] = "1.9.0"; // left from a run that never cleaned up
        _launcher.OnStart = (_, argument) => argument is null ? new FakeProcess() : new FakeProcess { HasExited = true };

        Assert.Equal(InstallOutcome.RolledBack, await installer.InstallAndRestartAsync(Update));
    }

    [Fact]
    public async Task A_restart_whose_swap_fails_starts_the_old_version_again()
    {
        _files.FailingMoves.Add($"{Current}→{Previous}");

        Assert.Equal(InstallOutcome.NotInstalled, await Installer.InstallAndRestartAsync(Update));

        Assert.Equal([(Current, null)], _launcher.Started);
        Assert.Equal("1.8.0", _files.Items[Current]);
    }

    [Fact]
    public void Reporting_started_clears_an_earlier_failure()
    {
        var installer = Installer;
        _files.Items[installer.FailedFile] = "1.9.0";

        installer.ReportStarted(new AppVersion(1, 9, 1));

        Assert.Null(installer.FailedVersion());
        Assert.Equal("1.9.1", _files.Items[installer.StartedFile]);
    }

    [Fact]
    public void The_disk_files_move_files_and_bundles_alike()
    {
        var root = Path.Combine(Path.GetTempPath(), "anemo-update-tests", Guid.NewGuid().ToString("N"));
        try
        {
            var files = DiskUpdateFiles.Instance;
            files.WriteText(Path.Combine(root, "a.exe"), "exe");
            Directory.CreateDirectory(Path.Combine(root, "A.app", "Contents"));
            File.WriteAllText(Path.Combine(root, "A.app", "Contents", "Info.plist"), "plist");

            files.Move(Path.Combine(root, "a.exe"), Path.Combine(root, "b.exe"));
            files.Move(Path.Combine(root, "A.app"), Path.Combine(root, "B.app"));
            Assert.Throws<IOException>(() => files.Move(Path.Combine(root, "b.exe"), Path.Combine(root, "B.app", "Contents", "Info.plist")));

            Assert.Equal("exe", files.ReadText(Path.Combine(root, "b.exe")));
            Assert.True(files.Exists(Path.Combine(root, "B.app")));
            files.Delete(Path.Combine(root, "B.app"));
            files.Delete(Path.Combine(root, "missing"));
            Assert.False(files.Exists(Path.Combine(root, "B.app")));
            Assert.Null(files.ReadText(Path.Combine(root, "missing")));
        }
        finally
        {
            if (Directory.Exists(root))
            {
                Directory.Delete(root, true);
            }
        }
    }
}
