using System.Text.RegularExpressions;

namespace Anemo.Desktop.Core.Storage;

/// <summary>Short lines about the connection, for the user to look at when something fails.</summary>
public interface IDiagnosticLog
{
    void Info(string message);
}

/// <summary>
/// The diagnostic log in a file (one per day, 7 days kept). Every line goes through
/// <see cref="Redact"/>, so a token can't reach the file even by mistake.
/// </summary>
public sealed partial class DiagnosticLog : IDiagnosticLog
{
    private const string Prefix = "connection-";
    private readonly string _folder;
    private readonly TimeProvider _time;
    private readonly object _lock = new();

    public DiagnosticLog(string folder, TimeProvider time)
    {
        _folder = folder;
        _time = time;
    }

    public void Info(string message)
    {
        var now = _time.GetUtcNow();
        lock (_lock)
        {
            try
            {
                Directory.CreateDirectory(_folder);
                var file = Path.Combine(_folder, $"{Prefix}{now:yyyy-MM-dd}.log");
                File.AppendAllText(file, $"{now:O} {Redact(message)}\n");
                foreach (var old in Directory.GetFiles(_folder, Prefix + "*.log"))
                {
                    if (File.GetLastWriteTimeUtc(old) < (now - CommandLog.KeepFor).UtcDateTime)
                    {
                        File.Delete(old);
                    }
                }
            }
            catch (IOException)
            {
                // Logging must never break the client.
            }
        }
    }

    /// <summary>Replaces anything that looks like an Anemo token with <c>anemo_…</c>.</summary>
    public static string Redact(string text) => TokenPattern().Replace(text, "anemo_…");

    [GeneratedRegex(@"anemo_[A-Za-z0-9_\-\.]+")]
    private static partial Regex TokenPattern();
}
