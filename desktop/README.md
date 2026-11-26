# Anemo Desktop (Windows and macOS)

The Windows client is below; the macOS client (a menu bar app, same features) is in
[macOS](#macos). Both share `Anemo.Desktop.Core`: the protocol, the rules and the Claude Code
job logic exist once.

A small tray program that lets Anemo's agent see and use a Windows computer: screenshots,
the window's controls through UI Automation, clicks, typing, keys, opening programs and,
on a trusted device with PowerShell switched on, PowerShell. What it does and why:
`docs/specs/06-desktop-client.md`; the wire protocol: `docs/device-contracts.md`.

It only connects out (one WebSocket to `wss://<anemo>/api/devices/ws`,
`PUT /api/devices/shared-screen` when you share the screen, and GitHub for its updates, 1.8.0). It
opens no port.

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

**Reading git history (1.5.0).** With sharing on, a trusted computer also answers Anemo's
read-only git requests for a project in the projects folder: its branches (with ahead and
behind), tags, recent commits, whether there are uncommitted changes, and one commit's
changed file names and line counts. Plugins on the Code page (`code:read`) and the agent
tool `code_git_graph` use them. Only a fixed set of read-only git commands runs, with its
arguments as a list (never through a shell), in a folder that must be inside the projects
folder (no `..`, no links out of it); never file contents or diffs. Contract:
`docs/device-contracts.md` §7.5.

**Remote repositories, fetching and pull requests (1.6.0).** The same reads also take a
GitHub repository of the owner (`repo: "owner/name"`) that isn't cloned on the computer: only
one in the owner's `gh repo list` (the owner set in Settings, else gh's account), cloned from
the URL in that list, never one Anemo sends. It is read from a *blobless bare clone* (commits
and trees, no file contents) in Anemo Desktop's own data folder, `%APPDATA%\Anemo
Desktop\git-cache\<owner>\<name>.git` (`~/Library/Application Support/Anemo
Desktop/git-cache/…` on the Mac), never in the projects folder, so no job and no project list
sees it. A clone is made in a temporary folder beside it and moved into place only once it is
complete; it is fetched again when Anemo asks (`fetch`) or when its last fetch is more than
10 minutes old. A repository over 1 GB (or whose clone takes over 3 minutes) is removed and
not read; past 3 GB in all, the least recently read repositories are removed. Anemo can clear the git
cache (the `code_git_cache_clear` action), or quit Anemo Desktop and delete the
`git-cache` folder. A local project can be fetched too (`git fetch --prune --all`, hooks off,
60 s; a failure still answers, with what was there). Where `gh` is signed in, the graph also
lists the repository's open pull requests (`gh pr list`, kept 2 minutes). A clone or fetch
git refuses for want of a sign-in answers `unauthenticated`: run `gh auth login` and
`gh auth setup-git`. Contract: `docs/device-contracts.md` §7.6.

**Files between this computer and Anemo's workspace (1.7.0).** With *Let Anemo read and write
files* ticked in Settings (*This computer*; off by default) and the device **trusted** in Anemo,
Anemo's agents can copy a file from here into the workspace (`device_file_get`) or a workspace
file onto this computer (`device_file_put`). Only inside the *Folders for files* (full paths,
separated by `;`; empty: your user folder), with links and junctions followed first, and never a
hidden file or folder below them, `AppData` (`~/Library` on the Mac) or Anemo Desktop's own
folder. A file is sent and received in chunks of up to 4 MB, each with its SHA-256, and the whole
file's SHA-256 is checked before a copy gets its name: until then it is a hidden
`.<name>.anemo-<id>.part` file in the same folder, removed if the copy fails, is aborted or waits
a minute without a chunk. An existing file is replaced only when Anemo asks for it
(`overwrite`), at most 200 MB per file, and the stop key stops copies too. Contract:
`docs/device-contracts.md` §8; design: `docs/specs/22-device-files.md`.

**Updates (1.8.0).** Anemo Desktop updates itself from this repository's GitHub Releases: a
minute after start and every 6 hours it asks GitHub (unauthenticated, with the last ETag) for the
newest stable `desktop-v…` Release newer than itself, downloads this computer's file, checks it
(the signature over the checksum file when the build has the release key, the SHA-256 from
`SHA256SUMS-desktop*.txt`, then the exe's version and a `--self-test` run on Windows, `codesign`
and the Team ID on the Mac) and installs it **when you quit**, or now from the tray item **Update
to X ready: Restart to update**, which waits until no command, file copy or Claude Code job is
running. *Update automatically* (Settings → This computer, on by default) switches it off; **Check
now** looks at once. The old version is kept beside the new one (`Anemo Desktop.old.exe`,
`.Anemo Desktop.old.app`) until the next update; a restarted version that doesn't come up is
replaced by the old one again. Only the published exe updates (not a `dotnet build` output), and
only in a folder its user can write. On the Mac an **ad hoc** build loses Screen Recording and
Accessibility at every update (allow them again). Design: `docs/specs/23-desktop-auto-update.md`.

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
    Updates/                  updates from GitHub Releases: picking, checksums, signature, the swap
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

1. Any pull request that changes the client's code raises `<Version>` in
   `Directory.Build.props` (and says what changed in this README if it's a feature); CI's
   *App versions* check fails until it does (docs and tests alone don't count). A PR that
   touches the version also runs the workflow as a dry run: the files appear under the run's
   *Artifacts*, and no Release is made.
2. Merge it. `.github/workflows/auto-release.yml` sees a version on main without a Release,
   creates the tag `desktop-v<Version>` on the merge commit and starts the Release workflow on
   it.
3. The workflow checks that the tag is `desktop-v` + `<Version>` and is on main (else it
   fails and publishes nothing), then makes the Release `desktop-v<version>` with
   `Anemo-Desktop-win-x64.exe`, `Anemo-Desktop-win-arm64.exe`, the macOS zip,
   `SHA256SUMS-desktop.txt` and the checksums in its notes. A re-run of a failed run adds the
   files to the same Release.

Clients 1.8.0 and later find the new Release by themselves within 6 hours (see *Updates*): a
Release must therefore have the exes, the zip and both checksum files under exactly these names.

Pushing a `desktop-v<version>` tag by hand still works the same way; a wrong tag is deleted
with `git push origin :desktop-v<version>` (and the Release, if one was made, on GitHub). If a
release was missed, **Actions → Auto release → Run workflow**. A dry run at any time:
**Actions → Release → Run workflow**, app *desktop*.

## Signing updates

Until this is set up, clients check an update's SHA-256 only, which catches a damaged download but
not someone who can replace a Release's files (docs/specs/23-desktop-auto-update.md, *Signing*).
Once, on a computer you trust (Git Bash or a Mac terminal; keep `anemo-update-key.pem` safe and
offline, losing it means users install the next version by hand once):

```
openssl ecparam -name prime256v1 -genkey -noout -out anemo-update-key.pem
gh secret set DESKTOP_UPDATE_SIGNING_KEY < anemo-update-key.pem
gh variable set DESKTOP_UPDATE_PUBLIC_KEY --body "$(openssl ec -in anemo-update-key.pem -pubout -outform DER | base64 | tr -d '\n')"
```

From the next Release on, the release job signs `SHA256SUMS-desktop.txt` and
`SHA256SUMS-desktop-macos.txt` (`.sig` beside each) and the clients it builds carry the public key
and accept only signed updates. A Release with the variable set but no secret fails instead of
publishing one the clients would refuse.

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
| Git cache (1.6.0) | `%APPDATA%\Anemo Desktop\git-cache\<owner>\<name>.git`: blobless bare clones of the owner's GitHub repositories for the remote git reads (no file contents); each repository's `anemo-fetched` and `anemo-read` files keep its last fetch and read; at most 1 GB each, 3 GB in all. `git-no-hooks` beside it is an empty folder git uses as `core.hooksPath` for every clone and fetch |
| Updates (1.8.0) | beside the exe: `<name>.download` while downloading, `<name>.new.exe` once checked, `<name>.old.exe` the version before the last update (to go back: quit, rename it back); `%APPDATA%\Anemo Desktop\updates\started` and `failed` (a version that didn't start, not fetched again by itself) |
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
shell's folder `~/AnemoWork`. Updates: the zip in `…/Anemo Desktop/updates/`, the checked app in
`.Anemo Desktop.update/` beside the app, the version before in `.Anemo Desktop.old.app` (hidden in
Finder; to go back: quit, `mv` it back).

**The bridge for agents.** `bridge/cc.mjs` (Node 18+, no packages) is the cross-platform
replacement of `C:\anemo-bridge\cc.ps1`: `node bridge/cc.mjs start --project <name> --prompt
"…"`, `status`, `log`, `list`, `cancel`, `projects`, `resolve`, in the same job folder format, so
its jobs show on the Code page too. Tests: `node --test bridge/cc.test.mjs`.

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
- Git reads (1.5.0) need sharing on and a trusted device, not control. They run git by its
  full path (never a `.cmd`/`.bat`) with `core.fsmonitor`, signature checks, optional locks
  and lazy fetches off, 10 s per command, and answer metadata only; credentials in remote
  URLs are removed.
- Files (1.7.0) only while *Let Anemo read and write files* is ticked, the device is trusted and
  control isn't paused; only inside the allowed folders once links are followed, never hidden
  files or folders, `AppData`/`Library` or the client's own folder, no network or device paths;
  written to a temporary file and renamed only once complete and its SHA-256 is right; an
  existing file replaced only with `overwrite`.
- Updates (1.8.0) come only from the compiled-in repository's GitHub Releases over HTTPS, are
  installed only after the checksum (and, with the release key, the signature) and the platform's
  checks pass, and never restart the client while a command, a copy or a Claude Code job runs.
- Remote git reads (1.6.0) clone only the owner's repositories, from the URL gh lists, into the
  git cache (checked to stay inside it once links are followed), with hooks, `ext::` and
  `file://` transports, submodules and automatic maintenance off and `GIT_TERMINAL_PROMPT=0`.
  A fetch never touches a working tree or a local branch. git's and gh's own error text is
  never passed on.
