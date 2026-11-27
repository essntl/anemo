using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;

namespace Anemo.Desktop.Core.Permissions;

/// <summary>Turns a PowerShell command into its syntax tree (as <c>parse-helper.ps1</c> describes it), without running it.</summary>
public interface IPowerShellParser
{
    /// <summary>The description, or null when no parser is available (no PowerShell, the helper failed).</summary>
    Task<JsonObject?> ParseAsync(string command, CancellationToken ct);
}

/// <summary>
/// The long-running parse helper of spec 25 §5.1 (a): <c>powershell.exe -NoProfile</c> (or pwsh)
/// running <c>parse-helper.ps1</c>, which reads one base64 command per line and answers one JSON
/// line. It only parses; it is started on first use and again after it dies. One request at a time.
/// </summary>
public sealed class PowerShellParseHelper : IPowerShellParser, IDisposable
{
    private static readonly TimeSpan AnswerTimeout = TimeSpan.FromSeconds(10);
    private readonly string? _program;
    private readonly SemaphoreSlim _one = new(1, 1);
    private Process? _process;

    /// <param name="program">The PowerShell to parse with; null finds one (Windows PowerShell, else pwsh).</param>
    public PowerShellParseHelper(string? program = null)
    {
        _program = program ?? Find();
    }

    /// <summary>Whether a PowerShell to parse with was found.</summary>
    public bool Available => _program is not null;

    /// <summary>Windows PowerShell on Windows (the shell commands run in), else pwsh on the PATH.</summary>
    public static string? Find()
    {
        if (OperatingSystem.IsWindows())
        {
            var system = Environment.GetFolderPath(Environment.SpecialFolder.System);
            var windowsPowerShell = Path.Combine(system, @"WindowsPowerShell\v1.0\powershell.exe");
            if (File.Exists(windowsPowerShell))
            {
                return windowsPowerShell;
            }
        }

        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            foreach (var name in OperatingSystem.IsWindows() ? new[] { "pwsh.exe", "powershell.exe" } : ["pwsh"])
            {
                var candidate = Path.Combine(dir, name);
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
        }

        return null;
    }

    /// <summary>The helper script, as built into the library.</summary>
    public static string Script()
    {
        using var stream = typeof(PowerShellParseHelper).Assembly.GetManifestResourceStream("Anemo.Desktop.Core.Permissions.parse-helper.ps1")
            ?? throw new InvalidOperationException("parse-helper.ps1 is missing from the build");
        using var reader = new StreamReader(stream, Encoding.UTF8);
        return reader.ReadToEnd();
    }

    public async Task<JsonObject?> ParseAsync(string command, CancellationToken ct)
    {
        if (_program is null)
        {
            return null;
        }

        await _one.WaitAsync(ct);
        try
        {
            for (var attempt = 0; attempt < 2; attempt++)
            {
                var process = Start();
                if (process is null)
                {
                    return null;
                }

                try
                {
                    var line = Convert.ToBase64String(Encoding.UTF8.GetBytes(command));
                    await process.StandardInput.WriteLineAsync(line.AsMemory(), ct);
                    await process.StandardInput.FlushAsync(ct);
                    using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                    timeout.CancelAfter(AnswerTimeout);
                    var answer = await process.StandardOutput.ReadLineAsync(timeout.Token);
                    if (answer is not null && JsonNode.Parse(answer) is JsonObject parsed)
                    {
                        return parsed;
                    }
                }
                catch (Exception e) when (e is IOException or OperationCanceledException or System.Text.Json.JsonException or InvalidOperationException)
                {
                    if (ct.IsCancellationRequested)
                    {
                        throw;
                    }
                }

                Stop(); // a dead or stuck helper: start a new one and try once more
            }

            return null;
        }
        finally
        {
            _one.Release();
        }
    }

    private Process? Start()
    {
        if (_process is { HasExited: false })
        {
            return _process;
        }

        Stop();
        var encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(Script()));
        var info = new ProcessStartInfo(_program!)
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = new UTF8Encoding(false),
            StandardInputEncoding = new UTF8Encoding(false),
        };
        foreach (var arg in new[] { "-NoProfile", "-NonInteractive", "-NoLogo", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded })
        {
            info.ArgumentList.Add(arg);
        }

        try
        {
            _process = Process.Start(info);
            _process?.BeginErrorReadLine(); // read and dropped, so a chatty stderr can't block it
            return _process;
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException or IOException)
        {
            _process = null;
            return null;
        }
    }

    private void Stop()
    {
        try
        {
            if (_process is { HasExited: false })
            {
                _process.Kill(entireProcessTree: true);
            }
        }
        catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            // already gone
        }

        _process?.Dispose();
        _process = null;
    }

    public void Dispose()
    {
        Stop();
        _one.Dispose();
    }
}
