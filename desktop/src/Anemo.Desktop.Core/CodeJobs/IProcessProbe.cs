namespace Anemo.Desktop.Core.CodeJobs;

/// <summary>A running process, as far as the job's liveness check needs it.</summary>
/// <param name="StartedAt">When it started; null when Windows won't say (another user's process).</param>
public sealed record ProcessFacts(DateTimeOffset? StartedAt);

/// <summary>Whether a job's process still runs (System.Diagnostics.Process in the app).</summary>
public interface IProcessProbe
{
    /// <summary>The running process with this id, or null when there is none (or it has exited).</summary>
    ProcessFacts? Find(int pid);
}

/// <summary>No process is ever running (where no probe is given, e.g. tests that don't need one).</summary>
public sealed class NoProcesses : IProcessProbe
{
    public static readonly NoProcesses Instance = new();

    public ProcessFacts? Find(int pid) => null;
}

public static class ProcessLiveness
{
    /// <summary>
    /// The job's process lives: a process with its pid runs and started no later than a
    /// minute after the job did (a later one is another program that got the pid again).
    /// A process whose start time can't be read counts as alive.
    /// </summary>
    public static bool IsAlive(IProcessProbe probe, int? pid, DateTimeOffset jobStarted)
    {
        if (pid is not { } id || probe.Find(id) is not { } process)
        {
            return false;
        }

        return process.StartedAt is not { } at || at <= jobStarted + CodeJobLimits.PidReuseSlack;
    }
}
