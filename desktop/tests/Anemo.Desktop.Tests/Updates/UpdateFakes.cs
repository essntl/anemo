using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Anemo.Desktop.Core.Updates;

namespace Anemo.Desktop.Tests.Updates;

/// <summary>GitHub Releases in memory: no test touches the network.</summary>
public sealed class FakeReleaseFeed : IReleaseFeed
{
    public JsonArray Releases { get; } = [];

    /// <summary>The files by "tag/name".</summary>
    public Dictionary<string, byte[]> Files { get; } = new(StringComparer.Ordinal);

    public string ETag { get; set; } = "\"v1\"";

    public List<string?> SentETags { get; } = [];

    public List<string> Downloaded { get; } = [];

    public Exception? ListFails { get; set; }

    /// <summary>Adds a release with the given files (their content is their name unless given).</summary>
    public void Add(string tag, bool draft = false, bool prerelease = false, params (string Name, byte[] Content)[] files)
    {
        var assets = new JsonArray();
        foreach (var (name, content) in files)
        {
            assets.Add(new JsonObject { ["name"] = name });
            Files[$"{tag}/{name}"] = content;
        }

        Releases.Add(new JsonObject { ["tag_name"] = tag, ["draft"] = draft, ["prerelease"] = prerelease, ["assets"] = assets });
    }

    public Task<ReleasesResponse> GetReleasesAsync(string? etag, CancellationToken ct)
    {
        SentETags.Add(etag);
        if (ListFails is { } e)
        {
            throw e;
        }

        return Task.FromResult(etag == ETag
            ? new ReleasesResponse(true, null, etag)
            : new ReleasesResponse(false, Releases.ToJsonString(), ETag));
    }

    public Task<byte[]> GetSmallAssetAsync(string tag, string asset, int maxBytes, CancellationToken ct) =>
        Files.TryGetValue($"{tag}/{asset}", out var bytes)
            ? Task.FromResult(bytes)
            : throw new ReleaseFeedException("The release or its file isn't on GitHub (any more).");

    public async Task DownloadAssetAsync(string tag, string asset, Stream target, long maxBytes, CancellationToken ct)
    {
        Downloaded.Add($"{tag}/{asset}");
        if (!Files.TryGetValue($"{tag}/{asset}", out var bytes))
        {
            throw new ReleaseFeedException("The release or its file isn't on GitHub (any more).");
        }

        await target.WriteAsync(bytes, ct);
    }
}

/// <summary>A host platform whose files live in a temporary folder; the platform checks are scripted.</summary>
public sealed class FakeUpdatePlatform(string folder) : IUpdatePlatform
{
    public string? Unavailable { get; set; }

    public string AssetName => "Anemo-Desktop-win-x64.exe";

    public string ChecksumsName => "SHA256SUMS-desktop.txt";

    public string? Note => null;

    public string DownloadPath => Path.Combine(folder, "Anemo Desktop.download");

    public IUpdateFiles Files => DiskUpdateFiles.Instance;

    public IUpdateLauncher Launcher { get; } = new FakeLauncher();

    /// <summary>Set to refuse the download in PrepareAsync (as a wrong version resource would).</summary>
    public string? Refuse { get; set; }

    public int CleanUps { get; private set; }

    public string Current => Path.Combine(folder, "Anemo Desktop.exe");

    public string Staged => Path.Combine(folder, "Anemo Desktop.new.exe");

    public void CleanUp() => CleanUps++;

    public Task<StagedUpdate> PrepareAsync(string downloaded, AppVersion version, CancellationToken ct)
    {
        if (Refuse is { } why)
        {
            throw new UpdateRefusedException(why);
        }

        File.Move(downloaded, Staged, overwrite: true);
        return Task.FromResult(new StagedUpdate(version, new UpdatePaths(Current, Staged, Path.Combine(folder, "Anemo Desktop.old.exe"))));
    }
}

/// <summary>A file system in a dictionary (path → content); a move or delete can be made to fail.</summary>
public sealed class FakeUpdateFiles : IUpdateFiles
{
    public Dictionary<string, string> Items { get; } = new(StringComparer.Ordinal);

    /// <summary>"from→to" moves that throw, as a locked file or a missing right would.</summary>
    public HashSet<string> FailingMoves { get; } = [];

    /// <summary>Paths whose delete throws this many more times.</summary>
    public Dictionary<string, int> FailingDeletes { get; } = new(StringComparer.Ordinal);

    public List<string> Log { get; } = [];

    public bool Exists(string path) => Items.ContainsKey(path);

    public void Move(string from, string to)
    {
        if (FailingMoves.Contains($"{from}→{to}"))
        {
            throw new UnauthorizedAccessException("denied");
        }

        if (!Items.Remove(from, out var content))
        {
            throw new FileNotFoundException(from);
        }

        if (Items.ContainsKey(to))
        {
            Items[from] = content;
            throw new IOException("exists");
        }

        Items[to] = content;
        Log.Add($"move {from} → {to}");
    }

    public void Delete(string path)
    {
        if (FailingDeletes.TryGetValue(path, out var left) && left > 0)
        {
            FailingDeletes[path] = left - 1;
            throw new IOException("in use");
        }

        if (Items.Remove(path))
        {
            Log.Add($"delete {path}");
        }
    }

    public string? ReadText(string path) => Items.GetValueOrDefault(path);

    public void WriteText(string path, string text) => Items[path] = text;
}

public sealed class FakeProcess : IUpdateProcess
{
    public bool HasExited { get; set; }

    public bool Killed { get; private set; }

    public void Kill()
    {
        Killed = true;
        HasExited = true;
    }
}

public sealed class FakeLauncher : IUpdateLauncher
{
    public List<(string Path, string? Argument)> Started { get; } = [];

    /// <summary>What a start does (e.g. write the started-file); returns the process to hand back.</summary>
    public Func<string, string?, IUpdateProcess?> OnStart { get; set; } = (_, _) => new FakeProcess();

    public IUpdateProcess? Start(string appPath, string? argument)
    {
        Started.Add((appPath, argument));
        return OnStart(appPath, argument);
    }
}

/// <summary>A release signing key made for the test, as release.yml's openssl would make one.</summary>
public sealed class TestSigningKey : IDisposable
{
    private readonly ECDsa _key = ECDsa.Create(ECCurve.NamedCurves.nistP256);

    public string PublicKey => Convert.ToBase64String(_key.ExportSubjectPublicKeyInfo());

    public byte[] Sign(string tag, byte[] checksums) =>
        _key.SignData(UpdateSignature.Message(tag, checksums), HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence);

    public void Dispose() => _key.Dispose();
}

public static class UpdateBytes
{
    public static byte[] Text(string text) => Encoding.UTF8.GetBytes(text);

    public static string Sha256(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}
