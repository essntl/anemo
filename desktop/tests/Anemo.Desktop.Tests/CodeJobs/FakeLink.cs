using System.Collections.Concurrent;
using Anemo.Desktop.Core.Connection;

namespace Anemo.Desktop.Tests.CodeJobs;

/// <summary>A link that records what is sent and whether the connection was dropped.</summary>
public sealed class FakeLink : ICodeJobsLink
{
    public ConcurrentQueue<string> Sent { get; } = new();

    public int Drops;

    public Task SendAsync(string text, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        Sent.Enqueue(text);
        return Task.CompletedTask;
    }

    public void Drop() => Interlocked.Increment(ref Drops);
}
