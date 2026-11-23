using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anemo.Desktop.Core.CodeJobs;
using Anemo.Desktop.Tests.Fakes;

namespace Anemo.Desktop.Tests.CodeJobs;

/// <summary>
/// The server side of device-contracts.md §7.1, as the real one does it: upserts jobs,
/// stores events once per seq, acks the highest seq with no gap, ignores events of jobs it
/// wasn't told about and malformed ids.
/// </summary>
public sealed partial class FakeCodeServer
{
    public ConcurrentDictionary<string, ServerJob> Jobs { get; } = new();

    /// <summary>What arrived, in order: "job:&lt;id&gt;:&lt;state&gt;" or "events:&lt;id&gt;:&lt;first&gt;-&lt;last&gt;".</summary>
    public ConcurrentQueue<string> Order { get; } = new();

    /// <summary>Changes the ack the server would send (job id, seq) → seq; e.g. to act as a restored database.</summary>
    public Func<string, long, long>? AckFilter { get; set; }

    /// <summary>Answers nothing (an old Anemo, or a lost frame).</summary>
    public bool Silent { get; set; }

    /// <summary>The ack for one message, or null when it is ignored.</summary>
    public (string JobId, long Seq)? Handle(JsonObject msg)
    {
        switch ((string?)msg["type"])
        {
            case "code.job":
            {
                var job = (JsonObject)msg["job"]!;
                var id = (string)job["id"]!;
                if (!IdPattern().IsMatch(id))
                {
                    return null;
                }

                var stored = Jobs.GetOrAdd(id, _ => new ServerJob());
                stored.Job = (JsonObject)job.DeepClone();
                stored.States.Add((string)job["state"]!);
                Order.Enqueue($"job:{id}:{job["state"]}");
                return Ack(id, stored);
            }

            case "code.events":
            {
                var id = (string)msg["job_id"]!;
                if (!Jobs.TryGetValue(id, out var stored))
                {
                    Order.Enqueue($"ignored:{id}");
                    return null;
                }

                var events = (JsonArray)msg["events"]!;
                foreach (var item in events.OfType<JsonObject>())
                {
                    stored.Events.TryAdd((long)item["seq"]!, (JsonObject)item.DeepClone());
                }

                stored.Frames++;
                Order.Enqueue($"events:{id}:{events[0]!["seq"]}-{events[^1]!["seq"]}");
                while (stored.Events.ContainsKey(stored.LastSeq + 1))
                {
                    stored.LastSeq++;
                }

                return Ack(id, stored);
            }

            default:
                return null;
        }
    }

    private (string, long)? Ack(string id, ServerJob job)
    {
        if (Silent)
        {
            return null;
        }

        var seq = AckFilter?.Invoke(id, job.LastSeq) ?? job.LastSeq;
        job.LastSeq = seq;
        return (id, seq);
    }

    public static JsonObject AckMessage(string jobId, long seq) => new() { ["type"] = "code.ack", ["job_id"] = jobId, ["seq"] = seq };

    [GeneratedRegex(@"^\d{8}-\d{6}-[A-Za-z0-9]{4}$")]
    private static partial Regex IdPattern();

    public sealed class ServerJob
    {
        public JsonObject? Job { get; set; }

        public List<string> States { get; } = [];

        public SortedDictionary<long, JsonObject> Events { get; } = new();

        public long LastSeq { get; set; }

        public int Frames { get; set; }
    }
}

/// <summary>A <see cref="CodeJobsSession"/> with a fake clock, a temp folder and the fake server.</summary>
public sealed class SessionHarness
{
    private readonly JobsFolder _folder;

    public SessionHarness(JobsFolder folder, ManualTime time, FakeProcesses processes, CodeJobStore store, ListLog log)
    {
        _folder = folder;
        Time = time;
        Processes = processes;
        Store = store;
        Log = log;
        NewSession();
    }

    public ManualTime Time { get; }

    public FakeProcesses Processes { get; }

    public CodeJobStore Store { get; }

    public ListLog Log { get; }

    public FakeCodeServer Server { get; set; } = new();

    public CodeJobsSession Session { get; private set; } = null!;

    /// <summary>Every text sent, in order.</summary>
    public List<string> Sent { get; } = [];

    /// <summary>Sent but not yet handed to the server.</summary>
    public Queue<string> Pending { get; } = new();

    public CodeJobsOptions Options { get; set; } = new();

    /// <summary>A new connection: a new session on the same state file (unanswered messages are lost).</summary>
    public CodeJobsSession NewSession()
    {
        Pending.Clear();
        Session = new CodeJobsSession(_folder.Jobs, Store, Processes, Time, Log, Options, (text, _) =>
        {
            Sent.Add(text);
            Pending.Enqueue(text);
            return Task.CompletedTask;
        });
        return Session;
    }

    /// <summary>One step 2 s later (so the folder is listed again).</summary>
    public async Task<CodeJobsEnd?> StepAsync()
    {
        Time.Now += TimeSpan.FromSeconds(2);
        return await Session.StepAsync();
    }

    /// <summary>Hands what was sent to the server and its acks back to the session.</summary>
    public int Deliver()
    {
        var count = 0;
        while (Pending.TryDequeue(out var text))
        {
            count++;
            if (Server.Handle(JsonNode.Parse(text)!.AsObject()) is { } ack)
            {
                Session.OnAck(ack.JobId, ack.Seq);
            }
        }

        return count;
    }

    /// <summary>Steps and delivers until nothing more is sent.</summary>
    public async Task SettleAsync(int maxRounds = 200)
    {
        for (var i = 0; i < maxRounds; i++)
        {
            Assert.Null(await StepAsync());
            if (Deliver() == 0)
            {
                // One more step: acks just delivered may open the next message.
                Assert.Null(await StepAsync());
                if (Deliver() == 0)
                {
                    return;
                }
            }
        }

        throw new InvalidOperationException("still sending after many rounds");
    }

    public IEnumerable<JsonObject> SentOf(string type) =>
        Sent.Select(t => JsonNode.Parse(t)!.AsObject()).Where(m => (string?)m["type"] == type);
}
