using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Anemo.Desktop.Core.Commands;
using Anemo.Desktop.Core.Platform;
using Anemo.Desktop.Core.Protocol;
using Anemo.Desktop.Core.Storage;

namespace Anemo.Desktop.Core.Files;

/// <summary>
/// The file actions of device-contracts.md §8 (Anemo Desktop 1.7.0): <c>file_stat</c> and
/// <c>file_read</c> for a copy into Anemo's workspace, <c>file_write_begin</c>,
/// <c>file_write_chunk</c>, <c>file_write_end</c> and <c>file_write_abort</c> for a copy onto
/// this computer. Only while "Let Anemo read and write files" is on and the device is trusted,
/// only paths <see cref="FileRules"/> allows.
///
/// A write goes to a hidden temporary file beside the target (<c>.name.anemo-&lt;id&gt;.part</c>,
/// the same folder so the final rename stays on one drive) and is renamed to its name only once
/// every byte is there and the whole file's SHA-256 is the one announced; an existing file is
/// replaced only when the begin said <c>overwrite</c>. A transfer that isn't continued for a
/// minute is dropped with its temporary file, so a broken copy never stays under the final name.
/// </summary>
public sealed class DeviceFiles : IDisposable
{
    /// <summary>The largest chunk taken or given (4 MB: about 5.6 MB as base64, inside both frame limits).</summary>
    public const int MaxChunkBytes = 4 * 1024 * 1024;

    /// <summary>The largest file copied either way (the server's own limit is lower, 50 MB unless set: 1–200 MB).</summary>
    public const long MaxFileBytes = 200L * 1024 * 1024;

    /// <summary>Copies onto this computer that may be open at once.</summary>
    public const int MaxTransfers = 4;

    /// <summary>A write without a chunk for this long is dropped.</summary>
    public static readonly TimeSpan TransferIdle = TimeSpan.FromSeconds(60);

    private static readonly HashSet<string> Actions = new(StringComparer.Ordinal)
    {
        "file_stat", "file_read", "file_write_begin", "file_write_chunk", "file_write_end", "file_write_abort",
    };

    private readonly Func<DesktopSettings> _settings;
    private readonly TimeProvider _time;
    private readonly string _home;
    private readonly IReadOnlyList<string> _protectedInHome;
    private readonly string? _ownData;
    private readonly Dictionary<string, Transfer> _transfers = new(StringComparer.Ordinal);
    private readonly object _lock = new();
    private readonly ITimer _sweeper;

    public DeviceFiles(Func<DesktopSettings> settings, TimeProvider time, DesktopPlatform platform, string? home = null, string? ownData = null)
    {
        _settings = settings;
        _time = time;
        _home = home ?? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        _protectedInHome = platform.ProtectedHomeFolders;
        _ownData = ownData;
        _sweeper = time.CreateTimer(_ => Sweep(), null, TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(30));
    }

    public static bool Handles(string action) => Actions.Contains(action);

    /// <summary>The offer's <c>files</c>: the switch is on and the device is trusted.</summary>
    public bool Offered(DeviceInfo device) => device.Trusted && _settings().ShareFiles;

    /// <summary>The rules as Settings has them now.</summary>
    public FileRules Rules() => new(_settings().FileFolders, _home, _protectedInHome, _ownData);

    /// <summary>How many writes are open (for tests and the log).</summary>
    public int OpenTransfers
    {
        get
        {
            lock (_lock)
            {
                return _transfers.Count;
            }
        }
    }

    internal JsonNode Run(string action, Args args, DeviceInfo device)
    {
        if (!device.Trusted)
        {
            throw CommandException.Refused("Files are only copied on a trusted computer, and this one is watched.");
        }

        if (!_settings().ShareFiles)
        {
            throw CommandException.Refused("Reading and writing files is switched off in Anemo Desktop on this computer (Let Anemo read and write files).");
        }

        Sweep();
        return action switch
        {
            "file_stat" => Stat(args),
            "file_read" => Read(args),
            "file_write_begin" => Begin(args),
            "file_write_chunk" => Chunk(args),
            "file_write_end" => End(args),
            "file_write_abort" => Abort(args),
            _ => throw CommandException.Failed($"Unknown action “{action}”"),
        };
    }

    // -- reading ------------------------------------------------------------------------------

    private JsonNode Stat(Args args)
    {
        var path = Rules().Check(args.String("path", FileRules.MaxPathLength));
        if (Directory.Exists(path))
        {
            return new JsonObject { ["kind"] = "folder", ["size"] = null, ["modified"] = Modified(Directory.GetLastWriteTimeUtc(path)) };
        }

        if (!File.Exists(path))
        {
            throw CommandException.NotFound("There is no such file on this computer.");
        }

        var size = new FileInfo(path).Length;
        var state = new JsonObject { ["kind"] = "file", ["size"] = size, ["modified"] = Modified(File.GetLastWriteTimeUtc(path)) };
        if (args.Bool("hash", false) && size <= MaxFileBytes)
        {
            using var stream = OpenRead(path);
            state["sha256"] = Hex(SHA256.HashData(stream));
        }

        return state;
    }

    private JsonNode Read(Args args)
    {
        var path = Rules().Check(args.String("path", FileRules.MaxPathLength));
        var offset = args.Int("offset", 0, int.MaxValue);
        var length = args.Int("length", 1, MaxChunkBytes);
        if (!File.Exists(path))
        {
            throw CommandException.NotFound("There is no such file on this computer.");
        }

        using var stream = OpenRead(path);
        if (stream.Length > MaxFileBytes)
        {
            throw CommandException.Failed("The file is larger than Anemo Desktop copies (200 MB).");
        }

        stream.Position = Math.Min(offset, stream.Length);
        var buffer = new byte[(int)Math.Min(length, Math.Max(0, stream.Length - stream.Position))];
        stream.ReadExactly(buffer);
        return new JsonObject
        {
            ["data"] = Convert.ToBase64String(buffer),
            ["sha256"] = Hex(SHA256.HashData(buffer)),
            ["size"] = stream.Length,
        };
    }

    private static FileStream OpenRead(string path) =>
        new(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);

    // -- writing ------------------------------------------------------------------------------

    private JsonNode Begin(Args args)
    {
        var path = Rules().Check(args.String("path", FileRules.MaxPathLength));
        var size = (long)(args.OptionalNumber("size") ?? -1);
        if (size < 0 || size > MaxFileBytes)
        {
            throw CommandException.Failed("“size” must be from 0 to 200 MB.");
        }

        var sha256 = Sha(args, "sha256");
        var overwrite = args.Bool("overwrite", false);
        if (Directory.Exists(path))
        {
            throw CommandException.Failed("A folder has that name.");
        }

        if (File.Exists(path) && !overwrite)
        {
            throw CommandException.Exists("A file with that name is already there.");
        }

        lock (_lock)
        {
            if (_transfers.Count >= MaxTransfers)
            {
                throw CommandException.Unavailable("Anemo Desktop is already taking several files; try again in a minute.");
            }
        }

        var folder = Path.GetDirectoryName(path) ?? throw CommandException.Failed("The path has no folder.");
        Directory.CreateDirectory(folder);
        // Made folders could have met a link put there meanwhile: the rules again, on the made path.
        Rules().Check(path);
        var id = Guid.NewGuid().ToString("N");
        var temp = Path.Combine(folder, $".{Path.GetFileName(path)}.anemo-{id[..8]}.part");
        var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None);
        lock (_lock)
        {
            _transfers[id] = new Transfer(id, path, temp, size, sha256, overwrite, stream, _time.GetUtcNow());
        }

        return new JsonObject { ["transfer"] = id, ["chunk_bytes"] = MaxChunkBytes };
    }

    private JsonNode Chunk(Args args)
    {
        var transfer = Find(args);
        var offset = (long)(args.OptionalNumber("offset") ?? -1);
        var data = Decode(args.String("data", (MaxChunkBytes / 3 * 4) + 4));
        var sha256 = Sha(args, "sha256");
        if (offset != transfer.Stream.Length)
        {
            Drop(transfer);
            throw CommandException.Failed("That chunk isn't the next one; the copy was stopped.");
        }

        if (Hex(SHA256.HashData(data)) != sha256)
        {
            Drop(transfer);
            throw CommandException.Failed("A chunk didn't match its SHA-256; the copy was stopped.");
        }

        if (offset + data.Length > transfer.Size)
        {
            Drop(transfer);
            throw CommandException.Failed("The chunks are larger than the file was said to be; the copy was stopped.");
        }

        transfer.Stream.Write(data);
        transfer.Touched = _time.GetUtcNow();
        return new JsonObject { ["received"] = transfer.Stream.Length };
    }

    private JsonNode End(Args args)
    {
        var transfer = Find(args);
        Drop(transfer, deleteTemp: false);
        try
        {
            transfer.Stream.Flush(flushToDisk: true);
            if (transfer.Stream.Length != transfer.Size)
            {
                throw CommandException.Failed("Not all of the file came; the copy was stopped.");
            }

            // What is on the disk, read back, must be what was announced.
            transfer.Stream.Position = 0;
            if (Hex(SHA256.HashData(transfer.Stream)) != transfer.Sha256)
            {
                throw CommandException.Failed("The file didn't match its SHA-256; the copy was stopped.");
            }

            transfer.Stream.Dispose();
            Rules().Check(transfer.Path);
            var replaced = File.Exists(transfer.Path);
            if (replaced && !transfer.Overwrite)
            {
                throw CommandException.Exists("Meanwhile a file with that name appeared; it was left as it is.");
            }

            try
            {
                File.Move(transfer.Temp, transfer.Path, overwrite: transfer.Overwrite);
            }
            catch (IOException) when (!transfer.Overwrite && File.Exists(transfer.Path))
            {
                throw CommandException.Exists("Meanwhile a file with that name appeared; it was left as it is.");
            }

            return new JsonObject
            {
                ["path"] = transfer.Path,
                ["size"] = transfer.Size,
                ["sha256"] = transfer.Sha256,
                ["replaced"] = replaced,
            };
        }
        finally
        {
            transfer.Stream.Dispose();
            DeleteQuietly(transfer.Temp);
        }
    }

    private JsonNode Abort(Args args)
    {
        var id = args.String("transfer", 64);
        Transfer? transfer;
        lock (_lock)
        {
            _transfers.TryGetValue(id, out transfer);
        }

        if (transfer is not null)
        {
            Drop(transfer);
        }

        return new JsonObject();
    }

    private Transfer Find(Args args)
    {
        var id = args.String("transfer", 64);
        lock (_lock)
        {
            return _transfers.TryGetValue(id, out var transfer)
                ? transfer
                : throw CommandException.Failed("That copy isn't open any more (it was stopped, or waited too long).");
        }
    }

    /// <summary>Forgets the transfer; with <paramref name="deleteTemp"/> also closes and deletes its temporary file.</summary>
    private void Drop(Transfer transfer, bool deleteTemp = true)
    {
        lock (_lock)
        {
            _transfers.Remove(transfer.Id);
        }

        if (deleteTemp)
        {
            transfer.Stream.Dispose();
            DeleteQuietly(transfer.Temp);
        }
    }

    /// <summary>Drops writes that waited longer than <see cref="TransferIdle"/>.</summary>
    public void Sweep()
    {
        List<Transfer> idle;
        lock (_lock)
        {
            var now = _time.GetUtcNow();
            idle = _transfers.Values.Where(t => now - t.Touched > TransferIdle).ToList();
        }

        foreach (var transfer in idle)
        {
            Drop(transfer);
        }
    }

    public void Dispose()
    {
        _sweeper.Dispose();
        List<Transfer> open;
        lock (_lock)
        {
            open = _transfers.Values.ToList();
        }

        foreach (var transfer in open)
        {
            Drop(transfer);
        }
    }

    private static void DeleteQuietly(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // Left behind as a hidden .part file; never under the final name.
        }
    }

    private static byte[] Decode(string base64)
    {
        try
        {
            var data = Convert.FromBase64String(base64);
            return data.Length <= MaxChunkBytes ? data : throw CommandException.Failed("A chunk is at most 4 MB.");
        }
        catch (FormatException)
        {
            throw CommandException.Failed("“data” must be base64.");
        }
    }

    private static string Sha(Args args, string key)
    {
        var value = args.String(key, 64).ToLowerInvariant();
        return value.Length == 64 && value.All(Uri.IsHexDigit)
            ? value
            : throw CommandException.Failed($"“{key}” must be a SHA-256 in hex.");
    }

    private static string Hex(byte[] hash) => Convert.ToHexString(hash).ToLowerInvariant();

    private static string Modified(DateTime utc) =>
        new DateTimeOffset(DateTime.SpecifyKind(utc, DateTimeKind.Utc)).ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture);

    private sealed class Transfer
    {
        public Transfer(string id, string path, string temp, long size, string sha256, bool overwrite, FileStream stream, DateTimeOffset now)
        {
            Path = path;
            Temp = temp;
            Size = size;
            Sha256 = sha256;
            Overwrite = overwrite;
            Stream = stream;
            Touched = now;
            Id = id;
        }

        public string Id { get; }

        public string Path { get; }

        public string Temp { get; }

        public long Size { get; }

        public string Sha256 { get; }

        public bool Overwrite { get; }

        public FileStream Stream { get; }

        public DateTimeOffset Touched { get; set; }
    }
}
