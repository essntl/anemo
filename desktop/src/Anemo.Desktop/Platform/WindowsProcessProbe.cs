using System;
using System.ComponentModel;
using System.Diagnostics;
using Anemo.Desktop.Core.CodeJobs;

namespace Anemo.Desktop.Platform;

/// <summary>A Claude Code job's process (the detached <c>cmd.exe</c> of <c>cc.ps1</c>), by pid.</summary>
internal sealed class WindowsProcessProbe : IProcessProbe
{
    public ProcessFacts? Find(int pid)
    {
        Process process;
        try
        {
            process = Process.GetProcessById(pid);
        }
        catch (ArgumentException)
        {
            return null; // no process with that id
        }
        catch (InvalidOperationException)
        {
            return null;
        }

        using (process)
        {
            try
            {
                if (process.HasExited)
                {
                    return null;
                }

                // Local time from Windows; compared with the job's start in Core.
                return new ProcessFacts(new DateTimeOffset(process.StartTime));
            }
            catch (Exception e) when (e is Win32Exception or InvalidOperationException or NotSupportedException)
            {
                // Another user's (or an elevated) process: it runs, its start time can't be read.
                return new ProcessFacts(null);
            }
        }
    }
}
