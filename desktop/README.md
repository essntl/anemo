# Anemo Desktop (Windows client)

A small tray program that lets Anemo's agent see and use a Windows computer: screenshots,
the window's controls through UI Automation, clicks, typing, keys, opening programs and,
on a trusted device with PowerShell switched on, PowerShell. What it does and why:
`docs/specs/06-desktop-client.md`; the wire protocol: `docs/device-contracts.md`.

It only connects out (one WebSocket to `wss://<anemo>/api/devices/ws`, and
`PUT /api/devices/shared-screen` when you share the screen). It opens no port.

**Claude Code jobs (1.1.0).** With *Share Claude Code jobs with Anemo* ticked in Settings
(off by default) and the device **trusted** in Anemo, the client watches the jobs folder of
`cc.ps1` (`C:\anemo-bridge\jobs` unless Settings names another) and sends each job's prompt,
state, branch and Claude Code events (its tool calls and output, trimmed to 16 000 bytes each)
over the same WebSocket, for the Code page. On a watched device, or with the box unticked,
nothing is sent. The full `out.jsonl` stays on the computer. Spec: `docs/specs/code-sessions.md`;
messages: `docs/device-contracts.md` §7.

## Layout

```
desktop/
  AnemoDesktop.sln
  src/Anemo.Desktop.Core/     net8.0: everything that can be tested anywhere
    CodeJobs/                 sharing Claude Code jobs: job folders, out.jsonl tailing, trimming, state, code.* frames
    Connection/               the WebSocket (hello, welcome, ping, offer, commands, close codes, back-off)
    Commands/                 the command handlers (look, act, shell), key names, refs, output capture, log summaries
    Control/                  "Allow control", the pause, hotkey parsing
    Platform/                 the interfaces the Windows app implements (desktop, input, clipboard, apps, shell, DPAPI)
    Protocol/                 the JSON messages
    SharedScreen/             "Share this screen with Anemo"
    Storage/                  settings.json, the command log, the connection log
    DesktopAgent.cs           all of it wired together, without a window
  src/Anemo.Desktop/          net8.0-windows WinForms app: the platform implementations, the tray,
                              the indicator, the Settings window
  tests/Anemo.Desktop.Tests/  xunit; a fake Anemo server (Kestrel) speaking device-contracts.md,
                              and fakes for every platform interface. Runs on Linux.
```

## Build and test

```
cd desktop
dotnet build -c Release -p:EnableWindowsTargeting=true
dotnet test -c Release -p:EnableWindowsTargeting=true
```

`EnableWindowsTargeting` lets the Windows app build on Linux (CI). The tests never touch the
real desktop: no mouse, keys, programs, clipboard, hotkeys, Startup shortcut or
`%APPDATA%`. What only a real Windows desktop can show is in `MANUAL-TESTS.md`.

## Publish (one self-contained exe)

```
cd desktop
dotnet publish src/Anemo.Desktop/Anemo.Desktop.csproj -c Release -r win-x64   -p:EnableWindowsTargeting=true -o publish/win-x64
dotnet publish src/Anemo.Desktop/Anemo.Desktop.csproj -c Release -r win-arm64 -p:EnableWindowsTargeting=true -o publish/win-arm64
```

Each gives `publish/<rid>/Anemo Desktop.exe` (about 75 MB, the .NET runtime included; no
install, no admin rights). `publish/` is not committed. The exe is not signed: Windows
SmartScreen asks once before the first start.

## Install on a computer

1. In Anemo: **Settings → Devices → Add a device**, kind *computer*, a name ("VM", "Desk
   PC") and a trust level. Copy the token (it is shown once).
2. Put `Anemo Desktop.exe` somewhere permanent (e.g. `%LOCALAPPDATA%\Programs\Anemo Desktop\`)
   and start it. The Settings window opens: paste the Anemo address (the one the web app
   uses, `https://…`) and the token. Save.
3. The tray icon turns from grey to normal when it is connected. It adds itself to the
   Startup folder ("Start with Windows", on by default).

**The VM needs a console session.** Windows has no desktop to see or act on in a
disconnected RDP session: use the hypervisor's console, keep the RDP window open, or
move the session to the console (`tscon <id> /dest:console`) before you disconnect.
Windows 10 1903 or later is needed (Windows.Graphics.Capture).

## Files on the computer

| What | Where |
|---|---|
| Settings | `%APPDATA%\Anemo Desktop\settings.json` (the token DPAPI-protected for the Windows user); a damaged or unreadable file starts the client with control off |
| Command log | `%APPDATA%\Anemo Desktop\logs\commands-<day>.jsonl`: action, a short summary and the outcome; never screenshots, typed or clipboard text, PowerShell commands or their output; 7 days |
| Connection log | `%APPDATA%\Anemo Desktop\logs\connection-<day>.log`: connects, drops, close codes, "code job discovered/ended" with the job id only; tokens are redacted; 7 days |
| Startup | `shell:startup\Anemo Desktop.lnk` |
| PowerShell's folder | `%USERPROFILE%\AnemoWork` unless set in Settings |
| Claude Code jobs | `%APPDATA%\Anemo Desktop\code-jobs.json`: per job only how far Anemo acked it (`acked_seq`, `acked_offset`), the last state sent and whether it is settled; jobs older than 14 days are forgotten; a damaged file starts empty (Anemo's acks repair it) |

## Rules the client keeps whatever the server sends

- Acting (click, type, keys, scroll, focus, open, clipboard) only while **Allow control** is
  on and control isn't paused; looking still works.
- PowerShell only when the device is **trusted** (from `welcome`) *and* PowerShell is switched
  on in Settings *and* control is allowed.
- Never typing into a password field: `type` checks the focus before the text and again
  after every Tab or line break; `press` refuses letters, digits, Space and pastes while a
  password field has the focus; when the focus can't be read, both refuse. Never Ctrl+Alt+Del
  (or Ctrl+Alt+End); never the client's own stop and share keys. Nothing on the secure
  desktop (UAC prompts, lock screen): it says so instead.
- PowerShell runs in a job object that ends it (and its children) when the client exits.
- The agent can't use Anemo Desktop's own windows (Settings, the Stop button).
- **Stop** (Ctrl+Alt+Shift+S by default, the indicator's button, or *Pause control for 1
  hour*): control is paused for an hour, the running command is cancelled and answered
  `stopped`, and `device.stopped` is sent.
- Claude Code jobs are sent only while *Share Claude Code jobs with Anemo* is ticked **and**
  `welcome` says the device is trusted; switching either off stops it at once. The client never
  starts, changes or cancels a job (1.1.0 only reads the jobs folder).
