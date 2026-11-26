using System.Text;
using System.Text.Json.Nodes;
using Anemo.Desktop.Core.Protocol;

namespace Anemo.Desktop.Core.CodeJobs;

/// <summary>
/// Messages for a running job (code-sessions.md §15, Anemo Desktop 1.9.0). A job started with
/// <c>input</c> runs Claude Code with <c>--input-format stream-json</c>; its stdin is a pipe
/// from a small PowerShell script in the job's folder (<c>feed.ps1</c>, <see cref="Script"/>)
/// that forwards the files of the job's <c>inbox</c> folder, in name order, one JSON line
/// each, and closes the pipe once Claude Code has answered and nothing more is waiting. The
/// script is a process of its own, so the job and its input outlive Anemo Desktop as the job
/// alone did before; Anemo Desktop only writes files into <c>inbox</c>.
///
/// Claude Code takes a message written while it works in at its next step (after the running
/// tool call) and echoes it on stdout with <c>"isReplay": true</c> and the message's
/// <c>uuid</c> (<c>--replay-user-messages</c>): that line is the proof of delivery. An
/// <c>interrupt</c> control request stops the current step first ("send now");
/// <c>cancel_async_message</c> withdraws a message Claude Code holds but hasn't taken in.
/// </summary>
public static class JobFeeder
{
    /// <summary>The folder of a job's messages: <c>*.jsonl</c> waiting, <c>*.sent</c> forwarded.</summary>
    public const string Inbox = "inbox";

    /// <summary>Written by the script when it closed Claude Code's stdin: no message is taken any more.</summary>
    public const string Closed = "closed";

    /// <summary>The script's file in the job's folder.</summary>
    public const string ScriptName = "feed.ps1";

    /// <summary>meta.json <c>input</c> of such a job.</summary>
    public const string MetaInput = "stream-json";

    /// <summary>The first message, the prompt (sorts before every later one).</summary>
    public const string PromptFile = "00000000000000000000-prompt.jsonl";

    public static string InboxOf(string jobFolder) => Path.Combine(jobFolder, Inbox);

    /// <summary>Whether the job still takes messages: its script hasn't closed Claude Code's stdin.</summary>
    public static bool IsOpen(string jobFolder) =>
        Directory.Exists(InboxOf(jobFolder)) && !File.Exists(Path.Combine(InboxOf(jobFolder), Closed));

    /// <summary>A user message as Claude Code's stream-json input takes it.</summary>
    public static string UserLine(string text, string? uuid) => Wire.Json(new JsonObject
    {
        ["type"] = "user",
        ["message"] = new JsonObject { ["role"] = "user", ["content"] = text },
        ["parent_tool_use_id"] = null,
        ["uuid"] = uuid,
    });

    /// <summary>A control request: <c>interrupt</c>, or <c>cancel_async_message</c> of <paramref name="uuid"/>.</summary>
    public static string ControlLine(string requestId, string subtype, string? uuid = null)
    {
        var request = new JsonObject { ["subtype"] = subtype };
        if (uuid is not null)
        {
            request["message_uuid"] = uuid;
        }

        return Wire.Json(new JsonObject { ["type"] = "control_request", ["request_id"] = requestId, ["request"] = request });
    }

    /// <summary>
    /// Writes a message file into the inbox: under a temporary name first, then renamed, so the
    /// script never reads half of it. <paramref name="name"/> sorts after the files before it.
    /// </summary>
    public static void Put(string jobFolder, string name, IEnumerable<string> lines)
    {
        var inbox = InboxOf(jobFolder);
        Directory.CreateDirectory(inbox);
        var path = Path.Combine(inbox, name);
        var temp = path + ".tmp";
        var text = new StringBuilder();
        foreach (var line in lines)
        {
            text.Append(line).Append('\n');
        }

        File.WriteAllText(temp, text.ToString(), new UTF8Encoding(false));
        File.Move(temp, path);
    }

    /// <summary>
    /// The command line of a job that takes messages: the script's output piped into Claude
    /// Code (<see cref="CodeJobControl.CommandLine"/> otherwise).
    /// </summary>
    public static string CommandLine(string powershell, string claude, string jobFolder, string? resumeSession, string? model, int? maxTurns)
    {
        var line = new StringBuilder(Quote(powershell))
            .Append(" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ")
            .Append(Quote(Path.Combine(jobFolder, ScriptName))).Append(' ').Append(Quote(jobFolder))
            .Append(" | ").Append(Quote(claude))
            .Append(" -p --input-format stream-json --output-format stream-json --verbose --replay-user-messages --permission-mode bypassPermissions");
        if (resumeSession is not null)
        {
            line.Append(" --resume ").Append(resumeSession);
        }

        if (model is not null)
        {
            line.Append(" --model ").Append(model);
        }

        if (maxTurns is { } turns)
        {
            line.Append(" --max-turns ").Append(turns.ToString(System.Globalization.CultureInfo.InvariantCulture));
        }

        line.Append(" > ").Append(Quote(Path.Combine(jobFolder, JobFolder.Out)))
            .Append(" 2> ").Append(Quote(Path.Combine(jobFolder, JobFolder.Err)));
        return "/d /v:off /s /c \"" + line + "\"";
    }

    private static string Quote(string path) => "\"" + path + "\"";

    /// <summary>
    /// The script (Windows PowerShell 5.1). It never builds JSON: it forwards what Anemo
    /// Desktop wrote. It ends, closing Claude Code's stdin, when Claude Code wrote a
    /// <c>result</c> and then no assistant or user line for <c>$quiet</c> while no message
    /// waits, when the job
    /// was cancelled, when the pipe breaks (Claude Code ended), or when Claude Code is no
    /// longer among the processes of the job's <c>cmd.exe</c>.
    /// </summary>
    public const string Script = """
        # Anemo Desktop: feeds a Claude Code job's messages to its stdin (docs/specs/code-sessions.md §15).
        # Written by Anemo Desktop into the job's folder; runs as long as the job takes messages.
        param([Parameter(Mandatory = $true)][string]$Job)
        $ErrorActionPreference = 'Stop'
        $inbox = Join-Path $Job 'inbox'
        $out = Join-Path $Job 'out.jsonl'
        $cancelled = Join-Path $Job 'cancelled'
        $quiet = [TimeSpan]::FromSeconds(4)
        $stdout = [Console]::OpenStandardOutput()
        $utf8 = New-Object System.Text.UTF8Encoding $false
        $pos = [long]0
        $answeredAt = $null
        $checkedAt = [DateTime]::UtcNow
        $parent = $null
        try { $parent = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId } catch { }

        function Test-ClaudeGone {
          if (-not $parent) { return $false }
          try {
            $others = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$parent" | Where-Object { $_.ProcessId -ne $PID })
            return $others.Count -eq 0
          } catch { return $false }
        }

        try {
          while ($true) {
            if (Test-Path -LiteralPath $cancelled) { break }
            foreach ($f in @(Get-ChildItem -LiteralPath $inbox -Filter '*.jsonl' -File | Sort-Object Name)) {
              $claimed = $f.FullName.Substring(0, $f.FullName.Length - 6) + '.sending'
              try { [System.IO.File]::Move($f.FullName, $claimed) } catch { continue }
              $bytes = [System.IO.File]::ReadAllBytes($claimed)
              $stdout.Write($bytes, 0, $bytes.Length)
              $stdout.Flush()
              [System.IO.File]::Move($claimed, $claimed.Substring(0, $claimed.Length - 8) + '.sent')
              $answeredAt = $null
            }
            if (Test-Path -LiteralPath $out) {
              $fs = [System.IO.File]::Open($out, 'Open', 'Read', 'ReadWrite, Delete')
              try {
                $length = $fs.Length
                if ($length -gt $pos) {
                  [void]$fs.Seek($pos, 'Begin')
                  $buffer = New-Object byte[] ([int][Math]::Min($length - $pos, 16MB))
                  $read = $fs.Read($buffer, 0, $buffer.Length)
                  $end = [Array]::LastIndexOf($buffer, [byte]10, $read - 1)
                  if ($end -lt 0 -and $read -eq $buffer.Length) { $end = $read - 1 }
                  if ($end -ge 0) {
                    $pos += $end + 1
                    foreach ($line in $utf8.GetString($buffer, 0, $end + 1).Split("`n")) {
                      if ($line.Length -lt 2) { continue }
                      # A result: Claude Code answered. It goes on (a queued message, a background
                      # task's news) only with a new assistant or user line; system lines after a
                      # result (commands_changed, task_progress, …) are bookkeeping.
                      if ($line.Contains('"type":"result"')) { $answeredAt = [DateTime]::UtcNow }
                      elseif ($line.StartsWith('{"type":"assistant"') -or $line.StartsWith('{"type":"user"')) { $answeredAt = $null }
                    }
                  }
                }
              } finally { $fs.Dispose() }
            }
            $waiting = @(Get-ChildItem -LiteralPath $inbox -Filter '*.jsonl' -File).Count
            if ($answeredAt -and $waiting -eq 0 -and ([DateTime]::UtcNow - $answeredAt) -gt $quiet) { break }
            if (([DateTime]::UtcNow - $checkedAt).TotalSeconds -ge 15) {
              $checkedAt = [DateTime]::UtcNow
              if (Test-ClaudeGone) { break }
            }
            Start-Sleep -Milliseconds 300
          }
        } catch {
          # The pipe broke: Claude Code has ended.
        } finally {
          try { [System.IO.File]::WriteAllText((Join-Path $inbox 'closed'), '') } catch { }
          try { $stdout.Close() } catch { }
        }
        """;
}
