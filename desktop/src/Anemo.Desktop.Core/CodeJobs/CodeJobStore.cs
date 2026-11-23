using System.Text.Json;
using System.Text.Json.Serialization;

namespace Anemo.Desktop.Core.CodeJobs;

/// <summary>What the client remembers of one job between connections and restarts.</summary>
public sealed record JobRecord
{
    /// <summary>The server's last ack (a fallback only: the server's next ack wins, D5).</summary>
    [JsonPropertyName("acked_seq")]
    public long AckedSeq { get; init; }

    /// <summary>The byte offset in <c>out.jsonl</c> after line <see cref="AckedSeq"/>.</summary>
    [JsonPropertyName("acked_offset")]
    public long AckedOffset { get; init; }

    /// <summary>The state of the last <c>code.job</c> the server acked.</summary>
    [JsonPropertyName("sent_state")]
    public string? SentState { get; init; }

    /// <summary>Its terminal state was sent and its events were acked to the end: never sent again.</summary>
    [JsonPropertyName("settled")]
    public bool Settled { get; init; }
}

/// <summary>
/// <c>%APPDATA%\Anemo Desktop\code-jobs.json</c> (code-sessions.md §4): per job
/// <c>{acked_seq, acked_offset, sent_state, settled}</c>, and since when jobs are shared.
/// Written whole to a temporary file, then moved into place. A damaged file starts empty:
/// the server's acks repair it.
/// </summary>
public sealed class CodeJobStore
{
    private static readonly JsonSerializerOptions Options = new() { WriteIndented = false };

    private readonly string _path;
    private readonly TimeProvider _time;
    private readonly Storage.IDiagnosticLog _log;
    private readonly object _lock = new();
    private Dictionary<string, JobRecord> _jobs = new(StringComparer.Ordinal);
    private DateTimeOffset? _sharedSince;
    private bool _loaded;

    public CodeJobStore(string path, TimeProvider time, Storage.IDiagnosticLog log)
    {
        _path = path;
        _time = time;
        _log = log;
    }

    public string Path => _path;

    /// <summary>
    /// When the first scan after sharing was switched on ran; null while sharing hasn't
    /// scanned yet. Jobs started more than 3 days before it are never taken.
    /// </summary>
    public DateTimeOffset? SharedSince
    {
        get
        {
            lock (_lock)
            {
                EnsureLoaded();
                return _sharedSince;
            }
        }
    }

    public JobRecord? Get(string id)
    {
        lock (_lock)
        {
            EnsureLoaded();
            return _jobs.GetValueOrDefault(id);
        }
    }

    /// <summary>The ids of every job remembered.</summary>
    public IReadOnlyCollection<string> Ids
    {
        get
        {
            lock (_lock)
            {
                EnsureLoaded();
                return _jobs.Keys.ToList();
            }
        }
    }

    public void Put(string id, JobRecord record)
    {
        lock (_lock)
        {
            EnsureLoaded();
            _jobs[id] = record;
            Write();
        }
    }

    public void SetSharedSince(DateTimeOffset? since)
    {
        lock (_lock)
        {
            EnsureLoaded();
            if (_sharedSince == since)
            {
                return;
            }

            _sharedSince = since;
            Write();
        }
    }

    /// <summary>Forgets jobs older than 14 days (by the time in their id).</summary>
    public void Prune()
    {
        lock (_lock)
        {
            EnsureLoaded();
            if (PruneOld())
            {
                Write();
            }
        }
    }

    /// <summary>True when a job of this id is too old to be remembered or discovered.</summary>
    public bool TooOld(string id) =>
        JobFolder.IdTime(id) is not { } t || t < _time.GetUtcNow() - CodeJobLimits.ForgetAfter;

    private void EnsureLoaded()
    {
        if (_loaded)
        {
            return;
        }

        _loaded = true;
        try
        {
            var file = JsonSerializer.Deserialize<StoreFile>(File.ReadAllText(_path), Options);
            _jobs = new Dictionary<string, JobRecord>(file?.Jobs ?? new(), StringComparer.Ordinal);
            _sharedSince = file?.SharedSince;
            foreach (var (id, record) in _jobs.ToList())
            {
                if (record is null || record.AckedSeq < 0 || record.AckedOffset < 0)
                {
                    _jobs.Remove(id);
                }
            }
        }
        catch (Exception e) when (e is FileNotFoundException or DirectoryNotFoundException)
        {
            // Nothing shared yet.
        }
        catch (Exception e) when (e is JsonException or NotSupportedException or IOException or UnauthorizedAccessException)
        {
            _log.Info("code jobs state file unreadable; starting empty");
            _jobs = new Dictionary<string, JobRecord>(StringComparer.Ordinal);
            _sharedSince = null;
        }

        PruneOld();
    }

    private bool PruneOld()
    {
        var old = _jobs.Keys.Where(TooOld).ToList();
        foreach (var id in old)
        {
            _jobs.Remove(id);
        }

        return old.Count > 0;
    }

    private void Write()
    {
        try
        {
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(_path)!);
            var temp = _path + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(new StoreFile { Jobs = _jobs, SharedSince = _sharedSince }, Options));
            File.Move(temp, _path, overwrite: true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // Only a fallback: the server's acks say where to go on.
            _log.Info($"code jobs state not saved: {e.GetType().Name}");
        }
    }

    private sealed class StoreFile
    {
        [JsonPropertyName("shared_since")]
        public DateTimeOffset? SharedSince { get; init; }

        [JsonPropertyName("jobs")]
        public Dictionary<string, JobRecord>? Jobs { get; init; }
    }
}
