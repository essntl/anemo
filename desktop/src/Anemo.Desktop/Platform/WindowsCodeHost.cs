using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Anemo.Desktop.Core.CodeJobs;

namespace Anemo.Desktop.Platform;

/// <summary>
/// gh, git and Claude Code jobs for the <c>code_*</c> actions. gh and git run hidden, in the
/// kill-on-close job object (a clone can't outlive the client); a job's <c>cmd.exe</c> runs
/// detached and windowless outside it, so the job outlives the client as with <c>cc.ps1</c>.
/// </summary>
internal sealed class WindowsCodeHost : ICodeHost
{
    /// <summary>gh's or git's output is read up to this much (a repository list is far smaller).</summary>
    private const int MaxOutputChars = 1024 * 1024;

    public string? FindOnPath(string program)
    {
        var extensions = Path.HasExtension(program)
            ? new[] { "" }
            : (Environment.GetEnvironmentVariable("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").Split(';', StringSplitOptions.RemoveEmptyEntries);
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            foreach (var extension in extensions)
            {
                try
                {
                    var candidate = Path.Combine(dir.Trim().Trim('"'), program + extension);
                    if (File.Exists(candidate))
                    {
                        return candidate;
                    }
                }
                catch (ArgumentException)
                {
                    // A PATH entry with characters a path can't have.
                }
            }
        }

        return null;
    }

    public async Task<ToolResult> RunAsync(ToolRun run, TimeSpan timeout, CancellationToken ct)
    {
        var info = new ProcessStartInfo(run.FileName)
        {
            WorkingDirectory = run.WorkingDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
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

        foreach (var (key, value) in run.Environment)
        {
            info.Environment[key] = value;
        }

        var stdout = new StringBuilder();
        var stderr = new StringBuilder();
        using var process = new Process { StartInfo = info };
        process.OutputDataReceived += (_, e) => Append(stdout, e.Data);
        process.ErrorDataReceived += (_, e) => Append(stderr, e.Data);
        process.Start();
        ShellJob.Add(process);
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
            Kill(process);
            if (!ct.IsCancellationRequested)
            {
                throw new TimeoutException();
            }

            throw;
        }

        process.WaitForExit(); // flushes the asynchronous readers
        lock (stdout)
        {
            lock (stderr)
            {
                return new ToolResult(process.ExitCode, stdout.ToString(), stderr.ToString());
            }
        }
    }

    public int StartDetached(DetachedStart start)
    {
        var program = start.FileName.Equals("cmd.exe", StringComparison.OrdinalIgnoreCase)
            ? Path.Combine(Environment.SystemDirectory, "cmd.exe")
            : start.FileName;
        var info = new ProcessStartInfo(program)
        {
            Arguments = start.CommandLine, // cmd.exe's own command line: it holds the redirections
            WorkingDirectory = start.WorkingDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        using var process = Process.Start(info) ?? throw new InvalidOperationException("cmd.exe didn't start.");
        return process.Id;
    }

    public bool KillTree(int pid)
    {
        Process process;
        try
        {
            process = Process.GetProcessById(pid);
        }
        catch (ArgumentException)
        {
            return true; // already gone
        }

        using (process)
        {
            return Kill(process);
        }
    }

    private static bool Kill(Process process)
    {
        try
        {
            process.Kill(entireProcessTree: true);
            return true;
        }
        catch (InvalidOperationException)
        {
            return true; // it ended meanwhile
        }
        catch (Exception e) when (e is Win32Exception or NotSupportedException or AggregateException)
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
