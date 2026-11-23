using System.Collections.Concurrent;
using Anemo.Desktop.Core.CodeJobs;

namespace Anemo.Desktop.Tests.CodeJobs;

/// <summary>gh, git and cmd.exe as the tests script them: nothing is ever really run.</summary>
public sealed class FakeCodeHost : ICodeHost
{
    /// <summary>Programs "on PATH": name → path.</summary>
    public ConcurrentDictionary<string, string> OnPath { get; } = new(StringComparer.OrdinalIgnoreCase);

    public ConcurrentQueue<ToolRun> Runs { get; } = new();

    /// <summary>What a run answers (and does, e.g. makes the clone's folder); exit 0 and no output by default.</summary>
    public Func<ToolRun, ToolResult> Answer { get; set; } = _ => new ToolResult(0, "", "");

    public ConcurrentQueue<DetachedStart> Started { get; } = new();

    /// <summary>The pid the next start answers; null makes the start throw.</summary>
    public int? NextPid { get; set; } = 9000;

    public ConcurrentQueue<int> Killed { get; } = new();

    public bool KillWorks { get; set; } = true;

    /// <summary>gh, git and claude on PATH.</summary>
    public static FakeCodeHost WithEverything()
    {
        var host = new FakeCodeHost();
        host.OnPath["gh"] = @"C:\Program Files\GitHub CLI\gh.exe";
        host.OnPath["git"] = @"C:\Program Files\Git\cmd\git.exe";
        host.OnPath["claude"] = @"C:\Users\me\AppData\Roaming\npm\claude.cmd";
        return host;
    }

    public string? FindOnPath(string program) => OnPath.TryGetValue(program, out var path) ? path : null;

    /// <summary>Instead of <see cref="Answer"/>: a run that takes its time (and can be cancelled).</summary>
    public Func<ToolRun, CancellationToken, Task<ToolResult>>? AnswerAsync { get; set; }

    public Task<ToolResult> RunAsync(ToolRun run, TimeSpan timeout, CancellationToken ct)
    {
        Runs.Enqueue(run);
        return AnswerAsync is { } answer ? answer(run, ct) : Task.FromResult(Answer(run));
    }

    public int StartDetached(DetachedStart start)
    {
        Started.Enqueue(start);
        return NextPid ?? throw new System.ComponentModel.Win32Exception(2);
    }

    /// <summary>Runs as the process tree is ended (e.g. the job writes its result just then).</summary>
    public Action<int>? OnKill { get; set; }

    public bool KillTree(int pid)
    {
        Killed.Enqueue(pid);
        OnKill?.Invoke(pid);
        return KillWorks;
    }
}
