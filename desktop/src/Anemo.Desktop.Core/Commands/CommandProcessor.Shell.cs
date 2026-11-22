using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using Anemo.Desktop.Core.Platform;

namespace Anemo.Desktop.Core.Commands;

public sealed partial class CommandProcessor
{
    /// <summary>Makes PowerShell write UTF-8 and no progress bars, so the output reads back cleanly.</summary>
    internal const string ShellPrelude =
        "$ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8\n";

    /// <summary>
    /// How PowerShell is started: no profile, never waiting for input, the command passed
    /// encoded (UTF-16LE, base64) so no quoting can change it.
    /// </summary>
    public static ShellStart ShellStartFor(string program, string command, string workFolder)
    {
        var encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(ShellPrelude + command));
        return new ShellStart(program, ["-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", encoded], workFolder);
    }

    private async Task<JsonNode> ShellAsync(Args args, CancellationToken ct)
    {
        var command = args.String("command", 8000);
        var timeout = args.Int("timeout_s", 1, 600, fallback: 60);
        var program = _platform.Shell.FindPowerShell()
            ?? throw CommandException.Unavailable("PowerShell wasn't found on this computer.");
        var folder = string.IsNullOrWhiteSpace(_settings().WorkFolder) ? _options.DefaultWorkFolder : _settings().WorkFolder!;
        _platform.Shell.EnsureFolder(folder);

        var stdout = new OutputCapture();
        var stderr = new OutputCapture();
        using var timeoutCts = new CancellationTokenSource(TimeSpan.FromSeconds(timeout));
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, timeoutCts.Token);
        var watch = Stopwatch.StartNew();
        int exitCode;
        try
        {
            exitCode = await _platform.Shell.RunAsync(
                ShellStartFor(program, command, folder), stdout.AppendLine, stderr.AppendLine, linked.Token);
        }
        catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested && !ct.IsCancellationRequested)
        {
            throw CommandException.Failed($"The command didn't finish within {timeout} seconds, so it was stopped.");
        }

        return new JsonObject
        {
            ["exit_code"] = exitCode,
            ["stdout"] = stdout.ToString(),
            ["stderr"] = stderr.ToString(),
            ["truncated"] = stdout.Truncated || stderr.Truncated,
            ["duration_ms"] = (long)watch.Elapsed.TotalMilliseconds,
        };
    }
}
