# Anemo Desktop (Windows and macOS)

The Windows client is below; the macOS client (a menu bar app, same features) is in
[macOS](#macos). Both share `Anemo.Desktop.Core`: the protocol, the rules and the Claude Code
job logic exist once.

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

**Starting jobs from Anemo (1.2.0).** With *Let Anemo start Claude Code jobs* also ticked (off
by default; it only counts while sharing is on), Anemo can list the projects
(`C:\dev` and the GitHub owner's repositories through `gh`: the owner set in Settings, else
the account `gh` is signed in as; with neither, no repositories are listed and nothing is
cloned), start a job in a project (cloning it with `gh` or `git`, or making a new
repository, when there is no such folder) and cancel one. A follow-up runs in the folder of
the job it follows. A job is started as `cc.ps1` does: `cmd.exe /d /v:off /s /c ""<full path
of claude>" -p --output-format stream-json --verbose --permission-mode bypassPermissions … <
prompt.txt > out.jsonl 2> err.txt"`, detached, with `NoDefaultCurrentDirectoryInExePath=1` (so a
`claude.cmd` in a cloned repository never runs), in the same jobs folder, so it is shared like
any other. Anemo gets its answer within seconds: a needed clone or `git init` runs afterwards
while the job folder holds a `starting` file; a clone that fails ends the job with the reason
in `err.txt`. **`bypassPermissions` means Anemo's agents can make Claude Code
do anything it can on this computer**: tick it only on a computer you'd give PowerShell to.
Needs `claude` on PATH, and `gh` (signed in) or `git` for cloning.

## Layout

```
desktop/
  AnemoDesktop.sln
  src/Anemo.Desktop.Core/     net8.0: everything that can be tested anywhere
    CodeJobs/                 Claude Code jobs: sharing (folders, tailing, trimming, state, code.* frames) and starting/cancelling
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
  src/Anemo.Desktop.Mac/      net8.0 macOS menu bar app (Avalonia): Native/ (P/Invoke), Platform/
                              (Core's interfaces on macOS), UI/; builds anywhere, runs on macOS 14+
  mac/                        Info.plist, Entitlements.plist, build-app.sh (the .app bundle)
  tests/Anemo.Desktop.Tests/  xunit; a fake Anemo server (Kestrel) speaking device-contracts.md,
                              and fakes for every platform interface. Runs on Linux.
  tests/Anemo.Desktop.Mac.Tests/  smoke tests of the Mac host's native calls; run only on macOS
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

## Cut a release

The `Release` workflow (`.github/workflows/release.yml`) builds both exes on a Windows runner
(so they carry the version resources) and attaches them to a GitHub Release, on a
`desktop-v<version>` tag. The server's images use `v<version>` tags; these are separate.

1. In a PR, raise `<Version>` in `Directory.Build.props` (and say what changed in this README
   if it's a feature). That PR runs the workflow as a dry run: the exes appear under the run's
   *Artifacts*, and no Release is made. Merge it once CI is green.
2. Tag the merge commit on main and push the tag:

   ```
   git checkout main && git pull
   git tag desktop-v1.2.0
   git push origin desktop-v1.2.0
   ```

3. The workflow checks that the tag is `desktop-v` + `<Version>` and is on main (else it
   fails and publishes nothing), then makes the Release `desktop-v1.2.0` with
   `Anemo-Desktop-win-x64.exe`, `Anemo-Desktop-win-arm64.exe`, `SHA256SUMS-desktop.txt`
   and the checksums in its notes. A re-run of a failed run adds the files to the same Release.

A wrong tag is deleted with `git push origin :desktop-v1.2.0` (and the Release, if one was
made, on GitHub). A dry run at any time: **Actions → Release → Run workflow**, app *desktop*
(the menu lists the workflow once it is on main).

## Install on a computer

1. In Anemo: **Settings → Devices → Add a device**, kind *computer*, a name ("VM", "Desk
   PC") and a trust level. Copy the token (it is shown once).
2. Download `Anemo-Desktop-win-x64.exe` (or `-win-arm64` for an ARM PC) from the latest
   `desktop-v…` Release, or build it (above). Name it `Anemo Desktop.exe`, put it somewhere permanent (e.g. `%LOCALAPPDATA%\Programs\Anemo Desktop\`)
   and start it. The Settings window opens: paste the Anemo address (the one the web app
   uses, `https://…`) and the token. Save.
3. The tray icon (the Anemo mark) turns from grey to dark when it is connected. It adds itself to the
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

## macOS

**Anemo Desktop for macOS** (1.4.0) does what the Windows client does: computer use, the shell
(zsh), Claude Code jobs for the Code page, *Share this screen*. Design and decisions:
`docs/specs/09-desktop-macos.md`; what still has to be tried on a real Mac:
`docs/specs/09-desktop-macos-mac-testing.md`. Needs macOS 14 Sonoma or later; built for Apple
Silicon (`osx-arm64`; an Intel build is `osx-x64` with the same script, untested).

| | Windows | macOS |
|---|---|---|
| Lives in | the tray | the menu bar (no Dock icon) |
| Screenshots | Windows.Graphics.Capture | ScreenCaptureKit (needs *Screen Recording*) |
| Controls, clicks, keys | UI Automation, SendInput | Accessibility, CGEvent (needs *Accessibility*) |
| Coordinates | physical pixels | points (a Retina screenshot's `scale` is about 1) |
| Shell | PowerShell | `zsh -f -c` (bash if there is no zsh) |
| Token | DPAPI | the login Keychain (`Anemo Desktop` / `device-token`) |
| Start at login | Startup folder shortcut | SMAppService (System Settings → General → Login Items) |
| Stop / share keys | Ctrl+Alt+Shift+S / A | Ctrl+Option+Shift+S / A |
| Claude Code jobs | `C:\anemo-bridge\jobs`, projects in `C:\dev` | `~/anemo-bridge/jobs`, projects in `~/dev` |
| Job start / cancel | `cmd.exe`, process tree | `posix_spawn` of `claude` (own process group), the group |

**Permissions.** At the first start (and from the menu, *Permissions…*) a window explains
*Screen Recording* and *Accessibility*, with a button that asks macOS and one that opens the
right page of System Settings. Only you can switch them on; the app never works around
macOS's prompts. Without them the agent is told to ask you. The client never looks at or
acts on System Settings or a password or permission prompt.

**Build an unsigned (ad hoc) dev build, on a Mac:**

```
# .NET 8 SDK: https://dotnet.microsoft.com/download (or: brew install dotnet@8)
cd desktop
dotnet test -c Release -p:EnableWindowsTargeting=true   # Core tests and the Mac smoke tests
sh mac/build-app.sh osx-arm64
open publish/osx-arm64                                  # Anemo Desktop.app is there
```

Or take `Anemo-Desktop-macos-arm64.zip` from a CI run (the *macOS client* job's *Artifacts*,
`desktop-macos`). Move the app to `/Applications` and start it; the first time macOS says it
can't check it: System Settings → Privacy & Security → *Open Anyway*.

**An ad hoc or unsigned build loses its permissions at every update.** macOS ties Screen
Recording and Accessibility to the app's signature, and an ad hoc signature is new with every
build. After an update both show as not allowed although System Settings still lists the app:
remove *Anemo Desktop* from both lists (the − button) and allow it again. A Developer ID-signed
build keeps them.

**Signing and notarizing** (release workflow, `desktop-macos` job): set these repository secrets
once there is an Apple Developer account. Without them the release is signed ad hoc and its
notes say so.

| Secret | |
|---|---|
| `MACOS_CERTIFICATE_P12` | the *Developer ID Application* certificate with its key, exported as .p12, base64 |
| `MACOS_CERTIFICATE_PASSWORD` | the .p12's password |
| `MACOS_SIGNING_IDENTITY` | e.g. `Developer ID Application: Artem Kotov (TEAMID)` |
| `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD` | for `notarytool` (an app-specific password from appleid.apple.com) |

**Files on the Mac:** settings and logs in `~/Library/Application Support/Anemo Desktop/`
(the same files as on Windows; `settings.json` holds only `keychain:v1` for the token), the
shell's folder `~/AnemoWork`.

**The bridge for agents.** `bridge/cc.mjs` (Node 18+, no packages) is the cross-platform
replacement of `C:\anemo-bridge\cc.ps1`: `node bridge/cc.mjs start --project <name> --prompt
"…"`, `status`, `log`, `list`, `cancel`, `projects`, `resolve`, in the same job folder format, so
its jobs show on the Code page too. Tests: `node --test bridge/`.

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
  `welcome` says the device is trusted; switching either off stops it at once.
- Anemo starts or cancels a job only while *Let Anemo start Claude Code jobs* is ticked, sharing
  is on and the device is trusted (and, to start one, control is allowed and not paused). The
  project is a plain folder name; the model, session and turns are checked against strict
  patterns; the prompt goes to Claude Code through `prompt.txt`, never on a command line.
  Cancelling ends the job's process tree only when that process is still the job's (a pid
  another program got since is left alone).
