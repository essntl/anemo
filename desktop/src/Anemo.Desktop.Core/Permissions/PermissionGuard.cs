using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Anemo.Desktop.Core.Commands;
using Anemo.Desktop.Core.Protocol;

namespace Anemo.Desktop.Core.Permissions;

/// <summary>
/// The device side of permission profiles (docs/specs/25-device-permission-profiles.md §6.1,
/// device-contracts.md §9): keeps the device's copy of its profile (<c>profile.sync</c>), answers
/// <c>shell.analyze</c>, and checks every <c>shell</c> again before it runs, refusing what the
/// profile doesn't allow whatever the server sent. With "Confirm loosened permissions on this
/// computer" on, a sync that loosens anything waits for a click here.
/// </summary>
public sealed class PermissionGuard
{
    private const int CacheSize = 64;
    private readonly PermissionStore _store;
    private readonly PowerShellAnalyser? _analyser;
    private readonly Func<bool> _confirmLoosening;
    private readonly Dictionary<string, ShellAnalysis> _cache = new(StringComparer.Ordinal);
    private readonly Queue<string> _order = new();
    private readonly object _lock = new();

    /// <param name="analyser">Null where there is no analyser (macOS): only the categories apply.</param>
    /// <param name="confirmLoosening">The device's own "Confirm loosened permissions on this computer" switch.</param>
    public PermissionGuard(PermissionStore store, PowerShellAnalyser? analyser, Func<bool> confirmLoosening)
    {
        _store = store;
        _analyser = analyser;
        _confirmLoosening = confirmLoosening;
    }

    /// <summary>A loosening arrived and waits for the user's click (the app shows a notification).</summary>
    public event Action<string>? ConfirmationNeeded;

    /// <summary>The profile in force or a pending one changed (the app sends an offer).</summary>
    public event Action? Changed;

    /// <summary>The profile enforced now (the legacy one when the server never sent any).</summary>
    public PermissionProfile Profile => _store.Applied ?? PermissionProfile.Legacy;

    /// <summary>The version of the profile in force, for the offer (0: none yet).</summary>
    public int Version => _store.Applied?.Version ?? 0;

    /// <summary>A loosening waits for the user's confirmation on this computer.</summary>
    public bool Pending => _store.Pending is not null;

    /// <summary>What the pending profile would loosen, in a sentence.</summary>
    public string? PendingText => _store.Pending is { } next ? Profile.DescribeLoosening(next) : null;

    /// <summary>Whether this client has the analyser (the <c>shell.analyze</c> capability).</summary>
    public bool CanAnalyze => _analyser is not null;

    /// <summary><c>profile.sync</c>: applies the profile, or holds it when it loosens and the switch is on.</summary>
    public JsonObject Sync(JsonNode? profile)
    {
        var next = PermissionProfile.FromJson(profile)
            ?? throw CommandException.Failed("The profile isn't one Anemo Desktop can read.");
        var current = _store.Applied;
        bool held;
        lock (_lock)
        {
            if (current is not null && next.Version < current.Version)
            {
                return Answer(false);
            }

            held = current is not null && _confirmLoosening() && current.LoosenedBy(next);
            if (held)
            {
                _store.Hold(next);
            }
            else
            {
                _store.Apply(next);
            }

            _cache.Clear();
            _order.Clear();
        }

        Changed?.Invoke();
        if (held)
        {
            ConfirmationNeeded?.Invoke(PendingText ?? "Anemo wants to loosen what agents may do on this computer. Allow?");
        }

        return Answer(!held);
    }

    private JsonObject Answer(bool applied) => new()
    {
        ["applied"] = applied,
        ["version"] = Version,
        ["pending"] = Pending,
    };

    /// <summary>The user allowed the pending loosening (the notification's Allow).</summary>
    public void Confirm()
    {
        if (_store.ConfirmPending())
        {
            lock (_lock)
            {
                _cache.Clear();
                _order.Clear();
            }

            Changed?.Invoke();
        }
    }

    /// <summary>The user said no: the old profile stays.</summary>
    public void Reject()
    {
        _store.RejectPending();
        Changed?.Invoke();
    }

    /// <summary><c>shell.analyze</c> (and the same check before <c>shell</c>): cached by the command's hash.</summary>
    public async Task<ShellAnalysis?> AnalyzeAsync(string command, string workFolder, CancellationToken ct)
    {
        if (_analyser is null)
        {
            return null;
        }

        var profile = Profile;
        var key = $"{profile.Version}|{workFolder}|{Hash(command)}";
        lock (_lock)
        {
            if (_cache.TryGetValue(key, out var hit))
            {
                return hit;
            }
        }

        var analysis = await _analyser.AnalyzeAsync(command, workFolder, profile, ct);
        lock (_lock)
        {
            if (_cache.TryAdd(key, analysis))
            {
                _order.Enqueue(key);
                while (_order.Count > CacheSize)
                {
                    _cache.Remove(_order.Dequeue());
                }
            }
        }

        return analysis;
    }

    /// <summary>
    /// Before <c>shell</c> runs (§6.1 step 6). Refuses when the profile denies it, when it asks and
    /// the server sent no approval, and when the server decided with a newer profile than this copy
    /// (it then syncs and tries once more). Returns the analysis, null where there is none.
    /// </summary>
    internal async Task<ShellAnalysis?> CheckShellAsync(Args args, string command, string workFolder, CancellationToken ct)
    {
        var level = Profile.Level("shell");
        if (level == "deny")
        {
            throw CommandException.Refused("The shell isn't allowed on this computer (its permission profile in Anemo).");
        }

        var sent = args.OptionalNumber("profile_version");
        if (sent is { } serverVersion && serverVersion > Version)
        {
            var why = Pending
                ? "This computer waits for its user to confirm new permissions (Anemo Desktop's notification), so it still enforces the old ones."
                : "This computer's copy of its permissions is older than the server's.";
            throw CommandException.Stale(why);
        }

        var analysis = await AnalyzeAsync(command, workFolder, ct);
        if (analysis is null)
        {
            return null; // no analyser here (macOS): the categories above are all the device checks
        }

        if (analysis.Verdict == Verdict.Deny)
        {
            throw CommandException.Refused($"Anemo Desktop refused this command: {analysis.Rule}.");
        }

        if (analysis.Verdict == Verdict.Ask && args.Node("approval") is not JsonObject)
        {
            throw CommandException.Refused($"This command needs the user's approval ({analysis.Rule}), and none came with it. Call the tool again.");
        }

        return analysis;
    }

    public static string Hash(string command) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(command))).ToLowerInvariant();

    /// <summary>The answer to <c>shell.analyze</c>.</summary>
    public static JsonObject Describe(ShellAnalysis? analysis, PermissionGuard guard)
    {
        if (analysis is null)
        {
            return new JsonObject { ["verdict"] = "unavailable", ["profile_version"] = guard.Version };
        }

        var json = analysis.ToJson();
        json["pending"] = guard.Pending;
        return json;
    }

}
