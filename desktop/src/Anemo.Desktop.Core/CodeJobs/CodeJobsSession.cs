using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anemo.Desktop.Core.Storage;

namespace Anemo.Desktop.Core.CodeJobs;

/// <summary>Why a sharing session stopped on its own.</summary>
public enum CodeJobsEnd
{
    /// <summary>A frame got no <c>code.ack</c> within 60 s: the connection should be made again.</summary>
    AckTimeout,

    /// <summary>
    /// Not a single <c>code.ack</c> came on this connection within 60 s: this Anemo doesn't
    /// take Claude Code jobs (or doesn't trust the device). Reconnecting wouldn't help.
    /// </summary>
    NeverAcked,
}

/// <summary>
/// Shares the jobs folder over one connection (device-contracts.md §7, code-sessions.md §4):
/// discovers job folders, works out their state, announces them with <c>code.job</c>, sends
/// their events in <c>code.events</c> frames one at a time per job, and goes on from the
/// server's acks. State that must outlive the connection is in the <see cref="CodeJobStore"/>.
/// Not thread-safe except <see cref="OnAck"/>: one loop drives it.
/// </summary>
public sealed class CodeJobsSession
{
    /// <summary>A frame reads at most this much of <c>out.jsonl</c> (the trimmed frame is far smaller).</summary>
    private const long MaxReadBytes = 8 * 1024 * 1024;

    private readonly string _folder;
    private readonly CodeJobStore _store;
    private readonly IProcessProbe _probe;
    private readonly TimeProvider _time;
    private readonly IDiagnosticLog _log;
    private readonly CodeJobsOptions _options;
    private readonly Func<string, CancellationToken, Task> _send;
    private readonly ConcurrentQueue<(string JobId, long Seq)> _acks = new();
    private readonly SemaphoreSlim _wake = new(0);
    private readonly Dictionary<string, Job> _jobs = new(StringComparer.Ordinal);
    private readonly HashSet<string> _ignored = new(StringComparer.Ordinal);
    private readonly DateTimeOffset _startedAt;
    private DateTimeOffset? _lastScan;
    private bool _anyAck;

    public CodeJobsSession(
        string folder,
        CodeJobStore store,
        IProcessProbe probe,
        TimeProvider time,
        IDiagnosticLog log,
        CodeJobsOptions options,
        Func<string, CancellationToken, Task> send)
    {
        _folder = folder;
        _store = store;
        _probe = probe;
        _time = time;
        _log = log;
        _options = options;
        _send = send;
        _startedAt = time.GetUtcNow();
    }

    /// <summary>The jobs this session follows (not settled), by id: for tests and the tray.</summary>
    public IReadOnlyCollection<string> Following => _jobs.Keys.ToList();

    /// <summary>A <c>code.ack</c> from the server; any thread.</summary>
    public void OnAck(string jobId, long seq)
    {
        _acks.Enqueue((jobId, seq));
        _wake.Release();
    }

    /// <summary>
    /// Per job, how many messages this session sent that no ack has come for yet. Asked once
    /// the session stopped: the server still answers those, and their acks must not be taken
    /// for answers to the next session's messages.
    /// </summary>
    public IReadOnlyDictionary<string, int> Unanswered()
    {
        var queued = _acks.GroupBy(a => a.JobId).ToDictionary(g => g.Key, g => g.Count());
        var unanswered = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var job in _jobs.Values.Where(j => j.InFlight is not null))
        {
            var left = 1 - queued.GetValueOrDefault(job.Id);
            if (left > 0)
            {
                unanswered[job.Id] = left;
            }
        }

        return unanswered;
    }

    /// <summary>Steps until cancelled or until the server stops answering.</summary>
    public async Task<CodeJobsEnd> RunAsync(CancellationToken ct)
    {
        while (true)
        {
            if (await StepAsync(ct) is { } end)
            {
                return end;
            }

            await _wake.WaitAsync(_options.PollInterval, ct);
        }
    }

    /// <summary>
    /// Applies the acks that came in, lists the folder when 2 s have passed, and sends what
    /// can be sent. Returns why sharing must stop, or null to go on.
    /// </summary>
    public async Task<CodeJobsEnd?> StepAsync(CancellationToken ct = default)
    {
        while (_acks.TryDequeue(out var ack))
        {
            ApplyAck(ack.JobId, ack.Seq);
        }

        var now = _time.GetUtcNow();
        if (_jobs.Values.FirstOrDefault(j => j.InFlight is { } f && now - f.At > _options.AckTimeout) is not null)
        {
            return _anyAck ? CodeJobsEnd.AckTimeout : CodeJobsEnd.NeverAcked;
        }

        if (_lastScan is null || now - _lastScan >= _options.PollInterval)
        {
            _lastScan = now;
            Scan(now);
        }

        await SendAsync(now, ct);
        return null;
    }

    private void Scan(DateTimeOffset now)
    {
        if (_store.SharedSince is not { } since)
        {
            since = now;
            _store.SetSharedSince(since);
        }

        _store.Prune();
        var cutoff = since - CodeJobLimits.BackfillWindow;
        foreach (var folder in ListFolders())
        {
            var id = Path.GetFileName(folder);
            if (_jobs.ContainsKey(id) || _ignored.Contains(id))
            {
                continue;
            }

            var record = _store.Get(id);
            if (!JobFolder.IsJobId(id) || record is { Settled: true } || _store.TooOld(id))
            {
                _ignored.Add(id);
                continue;
            }

            if (JobFolder.ReadMeta(folder, id) is not { } meta)
            {
                continue; // being written; tried again at the next scan
            }

            if (record is null && meta.Started < cutoff)
            {
                _ignored.Add(id); // older than the back-fill window when sharing started
                continue;
            }

            var job = new Job(id, folder, meta, JobFolder.ReadPrompt(folder, meta), record);
            _jobs[id] = job;
            if (record is null)
            {
                _log.Info($"code job discovered: {id}");
            }
        }

        foreach (var job in _jobs.Values)
        {
            Refresh(job);
        }
    }

    private IEnumerable<string> ListFolders()
    {
        try
        {
            return Directory.EnumerateDirectories(_folder).ToList();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return [];
        }
    }

    /// <summary>Works out the job's state (§7.2), pid and branch from its folder.</summary>
    private void Refresh(Job job)
    {
        var wasTerminal = JobStates.IsTerminal(job.State);
        if (!wasTerminal && JobFolder.ReadMeta(job.Folder, job.Id) is { } meta)
        {
            job.Meta = meta; // the pid may be filled in after the folder was made
        }

        var cancelled = JobFolder.IsCancelled(job.Folder);
        var alive = JobState.IsAlive(job.Folder, job.Meta, _probe, _time.GetUtcNow());
        ScanForResult(job); // after the liveness check: a job that just ended is read to its end once more
        var state = cancelled ? JobStates.Cancelled
            : job.ResultFailed is { } failed ? (failed ? JobStates.Failed : JobStates.Done)
            : alive ? JobStates.Running
            : JobStates.ExitedWithoutResult;
        if (wasTerminal && state == JobStates.Running)
        {
            state = job.State!; // a process that is gone doesn't come back
        }

        if (!wasTerminal)
        {
            job.Branch = JobFolder.Branch(job.Meta.Dir); // frozen once the job ended
        }

        if (JobStates.IsTerminal(state) && (!wasTerminal || state != job.State))
        {
            job.Ended = JobFolder.EndedAt(job.Folder, cancelled);
            job.StderrTail = JobFolder.StderrTail(job.Folder);
            if (job.State is not null)
            {
                _log.Info($"code job ended: {job.Id} ({state})");
            }
        }

        job.State = state;
    }

    /// <summary>Looks for a <c>result</c> event in the lines written since the last look.</summary>
    private static void ScanForResult(Job job)
    {
        job.ResultScan = JsonlTail.Each(job.OutPath, job.ResultScan, line =>
        {
            if (JobState.ResultOf(line.Text) is { } failed)
            {
                job.ResultFailed = failed;
            }
        });
    }

    private async Task SendAsync(DateTimeOffset now, CancellationToken ct)
    {
        var inFlight = _jobs.Values.Count(j => j.InFlight is not null);
        // Running jobs first, then the newest: a back-fill doesn't hold up a job being watched.
        var order = _jobs.Values
            .Where(j => j.InFlight is null)
            .OrderBy(j => j.State == JobStates.Running ? 0 : 1)
            .ThenByDescending(j => j.Meta.Started)
            .ToList();
        foreach (var job in order)
        {
            if (inFlight >= _options.MaxJobsInFlight)
            {
                break;
            }

            if (await SendNextAsync(job, now, ct))
            {
                inFlight++;
            }
        }
    }

    /// <summary>Sends the job's next message, if it has one: a <c>code.job</c> or a frame of events.</summary>
    private async Task<bool> SendNextAsync(Job job, DateTimeOffset now, CancellationToken ct)
    {
        var atEnd = job.Announced && !JsonlTail.HasLineAfter(job.OutPath, job.Position);
        var snapshot = Snapshot(job, atEnd);
        var changed = job.LastSent is not { } last
            || last.State != snapshot.State || last.Branch != snapshot.Branch || last.Pid != snapshot.Pid;
        var final = JobStates.IsTerminal(snapshot.State) && snapshot.State == job.State && atEnd;
        if (!job.Announced || changed || (final && !job.FinalSent))
        {
            await SendOneAsync(job, new Sent(now, snapshot, final, null), CodeWire.Job(snapshot), ct);
            return true;
        }

        if (atEnd)
        {
            return false;
        }

        var items = Frame(job);
        if (items.Count == 0)
        {
            return false;
        }

        await SendOneAsync(job, new Sent(now, null, false, items), CodeWire.Events(job.Id, items), ct);
        return true;
    }

    /// <summary>Sends one message and waits for its ack; one that didn't go out waits for nothing.</summary>
    private async Task SendOneAsync(Job job, Sent sent, string text, CancellationToken ct)
    {
        job.InFlight = sent;
        try
        {
            await _send(text, ct);
        }
        catch
        {
            job.InFlight = null;
            throw;
        }
    }

    /// <summary>
    /// The job as the next <c>code.job</c> says it. A job that ended keeps the state the server
    /// last heard until its events are acked to the end (they go before the terminal state);
    /// a job seen for the first time already ended is announced with its terminal state.
    /// </summary>
    private static JobSnapshot Snapshot(Job job, bool atEnd)
    {
        var state = job.State!;
        if (JobStates.IsTerminal(state) && !atEnd && (job.LastSent?.State ?? job.Record?.SentState) is { } previous)
        {
            state = previous;
        }

        var terminal = JobStates.IsTerminal(state);
        return new JobSnapshot(
            job.Id,
            job.Folder,
            JobFolder.Project(job.Meta.Dir),
            job.Meta.Dir,
            job.Meta.Started,
            job.Prompt,
            job.Meta.ResumeSession,
            job.Meta.Model,
            job.Meta.Pid,
            state,
            terminal ? job.Ended : null,
            job.Branch,
            terminal ? job.StderrTail : null);
    }

    /// <summary>The next events after the acked position: ≤ 200 items and ≤ 256 KB of UTF-8 in all.</summary>
    private static List<EventItem> Frame(Job job)
    {
        var items = new List<EventItem>();
        var bytes = CodeWire.FrameOverhead(job.Id);
        foreach (var line in JsonlTail.Read(job.OutPath, job.Position, CodeJobLimits.MaxEventsPerFrame, MaxReadBytes))
        {
            var item = CodeWire.Item(line.Seq, EventTrimmer.FromLine(line.Text), line.EndOffset);
            var size = Encoding.UTF8.GetByteCount(item.Json) + (items.Count > 0 ? 1 : 0);
            if (items.Count > 0 && bytes + size > CodeJobLimits.MaxFrameBytes)
            {
                break;
            }

            items.Add(item);
            bytes += size;
        }

        return items;
    }

    private void ApplyAck(string jobId, long seq)
    {
        if (!_jobs.TryGetValue(jobId, out var job) || job.InFlight is not { } sent)
        {
            return; // not asked for (late, repeated, or another job): nothing waits on it
        }

        _anyAck = true;
        job.InFlight = null;
        job.Position = PositionFor(job, seq, sent.Items);
        if (sent.Snapshot is { } snapshot)
        {
            job.Announced = true;
            job.LastSent = snapshot;
            job.FinalSent = sent.Final;
        }

        var settled = sent.Final && !JsonlTail.HasLineAfter(job.OutPath, job.Position);
        job.Record = new JobRecord
        {
            AckedSeq = job.Position.Seq,
            AckedOffset = job.Position.Offset,
            SentState = job.LastSent?.State,
            Settled = settled,
        };
        _store.Put(job.Id, job.Record);
        if (settled)
        {
            _jobs.Remove(job.Id);
            _ignored.Add(job.Id);
        }
        else if (sent.Final)
        {
            job.FinalSent = false; // the server is missing events: send them, then the state again
        }
    }

    /// <summary>
    /// The position after line <paramref name="seq"/>: from what is known (the frame just
    /// acked, the current position, the saved one), else counted from the nearest known
    /// position before it. The server's seq always wins, also when it is lower (D5).
    /// </summary>
    private static LinePosition PositionFor(Job job, long seq, List<EventItem>? items)
    {
        var known = new List<LinePosition> { LinePosition.Start, job.Position };
        if (job.Record is { } record && IsLineEnd(job.OutPath, record.AckedOffset))
        {
            known.Add(new LinePosition(record.AckedOffset, record.AckedSeq));
        }

        if (items is not null)
        {
            known.AddRange(items.Select(i => new LinePosition(i.EndOffset, i.Seq)));
        }

        if (seq <= 0)
        {
            return LinePosition.Start;
        }

        foreach (var p in known)
        {
            if (p.Seq == seq)
            {
                return p;
            }
        }

        var from = known.Where(p => p.Seq < seq).MaxBy(p => p.Seq);
        return JsonlTail.Seek(job.OutPath, from, seq);
    }

    /// <summary>True when <paramref name="offset"/> is the start of the file or follows a <c>\n</c>.</summary>
    private static bool IsLineEnd(string path, long offset)
    {
        if (offset == 0)
        {
            return true;
        }

        try
        {
            using var stream = JobFolder.OpenShared(path);
            if (offset > stream.Length)
            {
                return false;
            }

            stream.Seek(offset - 1, SeekOrigin.Begin);
            return stream.ReadByte() == '\n';
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    /// <summary>A message waiting for its ack: a <c>code.job</c> (snapshot) or a frame (items).</summary>
    private sealed record Sent(DateTimeOffset At, JobSnapshot? Snapshot, bool Final, List<EventItem>? Items);

    private sealed class Job
    {
        public Job(string id, string folder, JobMeta meta, string prompt, JobRecord? record)
        {
            Id = id;
            Folder = folder;
            Meta = meta;
            Prompt = prompt;
            Record = record;
            OutPath = Path.Combine(folder, JobFolder.Out);
        }

        public string Id { get; }

        public string Folder { get; }

        public string OutPath { get; }

        public string Prompt { get; }

        public JobMeta Meta { get; set; }

        /// <summary>What the state file said (or the last ack saved).</summary>
        public JobRecord? Record { get; set; }

        public string? State { get; set; }

        public string? Branch { get; set; }

        public DateTimeOffset? Ended { get; set; }

        public string? StderrTail { get; set; }

        /// <summary>How far <c>out.jsonl</c> was searched for a <c>result</c> event.</summary>
        public LinePosition ResultScan { get; set; } = LinePosition.Start;

        /// <summary>Null while no <c>result</c> event was written; else whether it failed.</summary>
        public bool? ResultFailed { get; set; }

        /// <summary>A <c>code.job</c> was acked on this connection: events may follow.</summary>
        public bool Announced { get; set; }

        /// <summary>The last <c>code.job</c> acked on this connection.</summary>
        public JobSnapshot? LastSent { get; set; }

        /// <summary>The terminal <c>code.job</c> after the last events was acked.</summary>
        public bool FinalSent { get; set; }

        /// <summary>The server's last ack, as a position in <c>out.jsonl</c>.</summary>
        public LinePosition Position { get; set; } = LinePosition.Start;

        public Sent? InFlight { get; set; }
    }
}
