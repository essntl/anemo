using System.Diagnostics;
using System.Text;
using Anemo.Desktop.Core.CodeJobs;
using Anemo.Desktop.Mac.Native;

namespace Anemo.Desktop.Mac.Platform;

/// <summary>
/// gh, git and Claude Code jobs for the <c>code_*</c> actions on macOS
/// (docs/specs/09-desktop-macos.md D6). gh and git run to their end with their output read; a
/// job is started with <c>posix_spawn</c> as its own session and process group, with no shell
/// in between, and cancelled by signalling that group.
/// </summary>
internal sealed class MacCodeHost : ICodeHost
{
    private const int MaxOutputChars = 1024 * 1024;
    private static readonly TimeSpan TermGrace = TimeSpan.FromSeconds(3);

    public string? FindOnPath(string program) => MacEnvironment.Find(program);

    public async Task<ToolResult> RunAsync(ToolRun run, TimeSpan timeout, CancellationToken ct)
    {
        var info = new ProcessStartInfo(run.FileName)
        {
            WorkingDirectory = run.WorkingDirectory,
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var arg in run.Arguments)
        {
            info.ArgumentList.Add(arg);
        }

        foreach (var (key, value) in MacEnvironment.ForChildren().Concat(run.Environment))
        {
            info.Environment[key] = value;
        }

        var stdout = new StringBuilder();
        var stderr = new StringBuilder();
        using var process = new Process { StartInfo = info };
        process.OutputDataReceived += (_, e) => Append(stdout, e.Data);
        process.ErrorDataReceived += (_, e) => Append(stderr, e.Data);
        process.Start();
        process.StandardInput.Close();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        using var timeoutCts = new CancellationTokenSource(timeout);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, timeoutCts.Token);
        try
        {
            await process.WaitForExitAsync(linked.Token);
        }
        catch (OperationCanceledException)
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
                // ended meanwhile
            }

            if (!ct.IsCancellationRequested)
            {
                throw new TimeoutException();
            }

            throw;
        }

        process.WaitForExit();
        lock (stdout)
        {
            lock (stderr)
            {
                return new ToolResult(process.ExitCode, stdout.ToString(), stderr.ToString());
            }
        }
    }

    public int StartJob(JobLaunch launch) => Posix.SpawnDetached(SpawnFor(launch, MacEnvironment.ForChildren()));

    /// <summary>What <see cref="StartJob"/> hands to posix_spawn: Claude Code itself, the job's files as its stdio.</summary>
    public static Posix.Spawn SpawnFor(JobLaunch launch, IReadOnlyDictionary<string, string> environment) => new(
        launch.Claude,
        launch.Arguments,
        launch.WorkingDirectory,
        launch.PromptPath,
        launch.OutPath,
        launch.ErrPath,
        environment);

    /// <summary>
    /// SIGTERM to the job's process group, SIGKILL after 3 s to whatever is left. A process that
    /// doesn't lead its own group (started by something else) gets .NET's tree kill.
    /// </summary>
    public bool KillTree(int pid)
    {
        if (Posix.GetPgid(pid) == pid)
        {
            if (!Posix.SignalGroup(pid, Posix.SigTerm))
            {
                return false;
            }

            var until = DateTime.UtcNow + TermGrace;
            while (DateTime.UtcNow < until && Posix.GroupAlive(pid))
            {
                Thread.Sleep(100);
            }

            return !Posix.GroupAlive(pid) || Posix.SignalGroup(pid, Posix.SigKill);
        }

        try
        {
            using var process = Process.GetProcessById(pid);
            process.Kill(entireProcessTree: true);
            return true;
        }
        catch (ArgumentException)
        {
            return true; // already gone
        }
        catch (InvalidOperationException)
        {
            return true;
        }
        catch (System.ComponentModel.Win32Exception)
        {
            return false;
        }
    }

    private static void Append(StringBuilder output, string? line)
    {
        if (line is null)
        {
            return;
        }

        lock (output)
        {
            if (output.Length < MaxOutputChars)
            {
                output.Append(line).Append('\n');
            }
        }
    }
}

/// <summary>Whether a job's process runs, and since when (System.Diagnostics.Process).</summary>
internal sealed class MacProcessProbe : IProcessProbe
{
    public ProcessFacts? Find(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            if (process.HasExited)
            {
                return null;
            }

            try
            {
                return new ProcessFacts(new DateTimeOffset(process.StartTime));
            }
            catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception or NotSupportedException)
            {
                return new ProcessFacts(null); // another user's: can't be read
            }
        }
        catch (ArgumentException)
        {
            return null;
        }
        catch (InvalidOperationException)
        {
            return null;
        }
    }
}
