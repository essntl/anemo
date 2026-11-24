# Anemo Desktop for macOS, and devices that say which shell they have

Workstream D of round 3 (`docs/specs/CONTRACTS-round3.md`). Anemo Desktop gets a macOS build
with the same features as the Windows client: Claude Code jobs (the Code page), computer use
(`computer_look` / `computer_act`), the shell tool and *Share this screen*. The server learns
which operating system and shell each computer has, so it no longer assumes PowerShell.

The manual test list for a real Mac is `09-desktop-macos-mac-testing.md`. Nothing in this
workstream could be run on a Mac while it was built (the VM is Windows): see §9.

## 1. What was Windows-only (inventory)

| Area | Windows today | Where |
| --- | --- | --- |
| Shell tool | PowerShell only: `pwsh` or 5.1, `-EncodedCommand`; the server rates commands with PowerShell rules and its description says PowerShell | `CommandProcessor.Shell.cs`, `tools/builtin/computer.py` |
| Wire | `hello` and `device.offer` say nothing about the OS or the shell | `Wire.cs`, `features/devices/ws.py`, `relay.py` |
| Claude Code jobs: folders | `C:\anemo-bridge\jobs`, `C:\dev` as constants | `CodeJobLimits.cs` |
| Claude Code jobs: start | `cmd.exe /d /v:off /s /c "…"` with the redirections, detached; `NoDefaultCurrentDirectoryInExePath` | `CodeJobControl.cs`, `WindowsCodeHost.cs` |
| Claude Code jobs: cancel | `Process.Kill(entireProcessTree)` (taskkill /T) | `WindowsCodeHost.cs` |
| The bridge for agents | `C:\anemo-bridge\cc.ps1` (PowerShell, called over `computer_shell`) | outside the repo |
| Seeing | Windows.Graphics.Capture / GDI, UI Automation, per-monitor DPI (physical pixels) | `Platform/*.cs` |
| Acting | SendInput with virtual-key codes, `Win` modifier, UIA patterns | `SendInputDevice.cs`, `Keys.cs` |
| Opening programs | the Start menu's apps (`shell:AppsFolder`) | `Windows.cs` |
| Token | DPAPI | `WindowsServices.cs` |
| Start at login | a shortcut in the Startup folder | `TrayApp.cs` |
| UI | WinForms tray icon and menu, WPF Settings window, always-on-top indicator, global hotkeys (`RegisterHotKey`) | `UI/*.cs` |
| Secure screen | UAC prompt / lock screen detection | `WindowsDesktop.cs` |

Everything else (the protocol, the connection, the command rules, refs, the password guard,
the Code job sharing and folder logic, settings, logs) is in `Anemo.Desktop.Core`, plain
`net8.0` with no OS calls, and is already covered by the 458 tests.

## 2. Decisions

**D1. One C# codebase: Core stays, a macOS host is added.** `src/Anemo.Desktop.Mac` (plain
`net8.0`, published for `osx-arm64`) implements Core's platform interfaces with macOS APIs,
like `src/Anemo.Desktop` does for Windows. Reasons: the protocol, the safety rules and the
Code job logic exist once and keep their tests; the Mac build compiles on this Windows VM and
on Linux CI (a Swift app would only compile on a Mac, and would mean a second copy of the
protocol and every rule); Artem reads one language. A full Swift rewrite was rejected for those
reasons; a Swift helper process for the native calls was rejected because everything it would
do is reachable from C# (below) and it would add a second build and a second language.

**D2. Native calls by P/Invoke, no Xamarin/`net8.0-macos` workload.** The macOS workload needs
Xcode to build, so it can't build here or on Linux. The C APIs (Accessibility `AXUIElement`,
CoreGraphics `CGEvent` / `CGWindowList` / `CGDisplay`, ImageIO, Security's Keychain, Carbon
hot keys, `posix_spawn`, `kill`) are plain `[DllImport]`s. The Objective-C APIs
(ScreenCaptureKit, `NSWorkspace`, `NSPasteboard`, `SMAppService`, `NSRunningApplication`) go
through `objc_msgSend` with a small, commented helper (`Native/ObjC.cs`); ScreenCaptureKit's
completion handlers are Objective-C blocks, built by hand in `Native/Blocks.cs` (the block ABI
is stable and documented by clang).

**D3. The UI is Avalonia.** The menu bar item (`TrayIcon` with a `NativeMenu` is an
`NSStatusItem` on macOS), the Settings window, the permission screens and the indicator are
Avalonia 11 windows in XAML (close to the WPF Settings window on Windows). It builds anywhere.
The app is an agent app (`LSUIElement`): a menu bar item, no Dock icon.

**D4. Coordinates on macOS are points.** macOS places windows, reads Accessibility frames and
posts mouse events in *points* of the global display space (top-left of the main display is
0,0; a display left of it has negative x). On a Retina display one point is 2×2 pixels. The
Mac host gives Core every rectangle and point in points. A screenshot is fitted from the
display's size **in points** (at most 1568 on the long side) and ScreenCaptureKit renders it
at that size from the full-resolution image, so `scale` in the state is *points per screenshot
pixel* (1.0 on a 1512×982-point MacBook Air screen, whose pixels are 3024×1964), and a click
at screenshot (x, y) lands on point origin + (x, y) × scale, the same formula as on Windows.
`computer_look what=screen` shows every display stitched together as they are arranged, as
the Windows client shows the virtual screen. The mapping is pure code in Core
(`Platform/DisplayLayout.cs`) with tests for 1× and 2× displays, mixed displays and displays
left of and above the main one (§8).

**D5. The shell is zsh.** `/bin/zsh -f -c <command>` (`-f`: no `.zshrc`/`.zprofile`, as
PowerShell's `-NoProfile`), stdin from `/dev/null` (never waits for input), the command as one
argument (nothing to quote), in the working folder (default `~/AnemoWork`), with `PATH` made of
`/etc/paths`, `/opt/homebrew/bin`, `/usr/local/bin` and `~/.local/bin` in front of what the app
got (an app started from Finder gets only `/usr/bin:/bin:/usr/sbin:/sbin`). If `/bin/zsh` is
missing, `/bin/bash --noprofile --norc -c`. Cancelling or a timeout ends the shell and its
children (`Process.Kill(entireProcessTree)`). The device says `shell_kind: "zsh"` (or
`"bash"`).

**D6. Claude Code jobs: same folder format, a native start on each OS, one Node bridge for
agents.** The contract is the folder (`prompt.txt`, `out.jsonl`, `err.txt`, `meta.json`,
`cancelled`, `starting`; ids `yyyyMMdd-HHmmss-xxxx`; `docs/device-contracts.md` §7). Who writes
it:

- *Anemo Desktop* keeps its own C# start (no Node needed by the client; the Windows path stays
  byte for byte what it is and keeps its tests). Core now describes a job as a `JobLaunch`
  (Claude Code's full path, its arguments, the job folder, the project folder); each host
  starts it its own way:
  - Windows: the `cmd.exe /d /v:off /s /c "…"` line as before (built in Core, unchanged).
  - macOS: `posix_spawn` of Claude Code itself, no shell at all: stdin/stdout/stderr opened on
    `prompt.txt` / `out.jsonl` / `err.txt` by the spawn's file actions, the project folder by
    `posix_spawn_file_actions_addchdir_np`, `POSIX_SPAWN_SETSID` so the job is its own session
    and process group and outlives the app, `POSIX_SPAWN_CLOEXEC_DEFAULT` so it inherits no
    other file of the app. A thread waits for it (`waitpid`) so it never stays a zombie that
    would look alive.
  - Cancel on macOS: `SIGTERM` to the job's process group (`kill(-pgid)`), `SIGKILL` to the
    group after 3 s if anything is left; a pid that isn't a group leader (a job started by
    something else) gets `Process.Kill(entireProcessTree)`. The pid-reuse check before it is
    Core's, unchanged.
  - Defaults on macOS: jobs in `~/anemo-bridge/jobs`, projects in `~/dev`.
  - Claude Code is found on `PATH` plus `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin`,
    `/usr/local/bin` (where its installers put it), never in a relative `PATH` entry; the job
    gets the same `PATH` (Claude Code may be a Node script that needs `node`).
- *`bridge/cc.mjs`* replaces `cc.ps1` for agents that drive Claude Code over the shell tool,
  on Windows, macOS and Linux (Node ≥ 18, no packages): the same commands (`projects`,
  `resolve`, `start`, `status`, `log`, `list`, `cancel`), the same folder format, the same
  project resolution. `start` spawns `claude` detached with the files as stdin/stdout/stderr
  (`detached: true` is `setsid` on macOS/Linux; on Windows a hidden detached process); `cancel`
  writes `cancelled` and ends the tree (`process.kill(-pid)` on macOS/Linux, `taskkill /PID
  <pid> /T /F` on Windows). Folders: `ANEMO_DEV_ROOT` / `ANEMO_JOBS_DIR`, else `C:\dev` and
  `C:\anemo-bridge\jobs` on Windows, `~/dev` and `~/anemo-bridge/jobs` elsewhere; the GitHub
  owner from `ANEMO_GITHUB_OWNER`, else the account `gh` is signed in as (cc.ps1 had it
  hard-coded). Tested with `node --test` and a fake `claude`. `C:\anemo-bridge\cc.ps1` itself is
  not touched; switching the VM to the Node bridge is Artem's call (§10).

  Why not have Anemo Desktop call the bridge: it would make Node a requirement of the client,
  change the Windows start path that works, and put a second process between the client and
  the job for no gain; the folder format already makes the two interchangeable (a job started
  by either is shared by the client and shown on the Code page).

**D7. Permissions are asked for, never worked around.** Computer use needs *Screen Recording*
(screenshots) and *Accessibility* (reading controls, clicking, typing). The app checks them
with `CGPreflightScreenCaptureAccess` and `AXIsProcessTrusted` (no prompt), and shows a
**Permissions** window (at first start, from the menu, and whenever a command needs one that is
missing) that says what each is for, has a button that asks macOS (`CGRequestScreenCaptureAccess`,
`AXIsProcessTrustedWithOptions(prompt: true)`) and one that opens the right pane of System
Settings (`x-apple.systempreferences:` URLs). The app never edits the TCC database, never uses
`tccutil`, AppleScript or UI scripting of System Settings, and never clicks or types into a
system permission prompt: while System Settings, a password or permission prompt
(SecurityAgent, UserNotificationCenter, universalAccessAuthWarn), the login window or the lock
screen is in front, every command answers `unavailable`, as the Windows client does on the
secure desktop. (This also means the agent can't help with System Settings at all; that is
deliberate.) Without Screen Recording, `look`
answers `unavailable` with a sentence telling the agent to ask the user to allow it; without
Accessibility, the controls list is empty with a `note`, and acting answers `unavailable`.

**D8. Token in the Keychain, login item with SMAppService, menu bar instead of tray.**
`ITokenProtector` on macOS stores the token as a generic password in the login Keychain
(service `Anemo Desktop`, account `device-token`, accessible after first unlock, this device
only) and writes only the marker `keychain:v1` into `settings.json`. *Open at login* (the
setting that is *Start with Windows* on Windows) uses `SMAppService.mainApp` (macOS 13+;
register/unregister; status shown). The menu bar item has the same menu as the tray icon and
turns red while a command runs; the indicator ("Anemo is using this computer" with Stop) is a
small always-on-top window.

**D9. Same rules on both systems.** Trust levels (watched asks for every action and never gets
the shell; trusted), approvals, *Allow control*, the pause, Stop, "never type passwords" and
"never its own windows" are Core's and the server's, unchanged. macOS specifics: a password
control is one whose role or subrole is `AXSecureTextField`, and while macOS has *Secure
Event Input* on (a password field has the keyboard somewhere) typing and text keys are refused
as if the focus were a password field. The stop hotkey is Ctrl+Option+Shift+S
(Carbon `RegisterEventHotKey`, which needs no permission); share is Ctrl+Option+Shift+A.
`press` takes `Cmd` as a modifier (and `Win` means Cmd there); Cmd+V counts as a paste for the
password guard. The client never presses Cmd+Ctrl+Q (lock screen), Cmd+Option+Esc (Force Quit),
Cmd+Ctrl+Power or Cmd+Option+Power (shut down / sleep): `refused`.

**D10. Build: Apple Silicon first.** `dotnet publish -r osx-arm64 --self-contained` and
`desktop/mac/build-app.sh` make `Anemo Desktop.app` (Info.plist, icon, entitlements). Signing
and notarization run in the release workflow only when the secrets exist
(`MACOS_CERTIFICATE_P12`, `MACOS_CERTIFICATE_PASSWORD`, `MACOS_SIGNING_IDENTITY`,
`APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD`); without them the app is ad-hoc signed
(`codesign -s -`) and the release notes say so. An Intel (`osx-x64`) build is one more line in
the workflow, not done now.

**Ad-hoc and unsigned builds lose their permissions on every update.** macOS ties a Screen
Recording / Accessibility grant to the app's code signature. An ad-hoc signature changes with
every build, so after an update macOS treats it as a new app: the old entries in System
Settings stay but no longer apply, and the user must remove them and allow the new build again.
A Developer ID-signed build keeps its grants across updates. This is also written in the
README, the release notes and the PR.

## 3. Wire changes (`docs/device-contracts.md`, all optional and backwards compatible)

- `hello` gets `"platform": "windows" | "macos"`; missing (old clients) means `"windows"`; any
  other value is treated as `"windows"` too.
- `device.offer` gets `"shell_kind": "powershell" | "pwsh" | "zsh" | "bash"`; missing means
  `"powershell"`; an unknown value is stored as `"powershell"`. The Windows client now sends
  `"platform": "windows"` and `"shell_kind": "pwsh"` or `"powershell"` (whichever it would
  run).
- The relay stores both in the device's `devices:online:<id>` hash (`platform`, `shell_kind`;
  the connection knows `platform` from `hello` and writes it with every offer); `Offer` and
  `DeviceInfo` get `platform` and `shell_kind` (defaults `"windows"` / `"powershell"`).
- §3: on macOS, coordinates and `scale` are points (D4); `press` takes `Cmd`; `open` takes an
  application's name (as in `/Applications`, e.g. `Safari`, `TextEdit`) or an http(s) URL.
- §7: on macOS the jobs folder is `~/anemo-bridge/jobs/<id>/` and projects are in `~/dev`;
  `device_job_dir` and `dir` are the device's own absolute paths, opaque strings to the server
  (it never parses them, and the Code page already handles `/` paths). `out.jsonl` is
  unchanged, so the Code page needs no change.
- Version: both clients are 1.3.0 (`desktop/Directory.Build.props`); the server needs no
  version check for it (the fields are optional).

## 4. Server changes

- `features/devices/ws.py`: reads `hello.platform`, keeps it on the connection, passes it and
  `offer.shell_kind` (validated against the four names) into `relay.Offer`.
- `features/devices/relay.py`: `Offer.platform`, `Offer.shell_kind`, `DeviceInfo.platform`,
  `DeviceInfo.shell_kind`; the Lua scripts store them; a hash written by an older server (no
  such fields) reads as Windows/PowerShell.
- `tools/builtin/computer.py`:
  - the device line in the turn context says the OS and the shell for a Mac:
    `- Mac: computer (macOS, shell: zsh), trusted, control allowed, zsh on`; a Windows
    computer's line stays exactly as it was (`- VM: computer, trusted, control allowed,
    PowerShell on`), and the section's first line says a computer is Windows with PowerShell
    unless its line names another system;
  - `computer_shell`'s description and input are shell-neutral ("one command for the
    computer's shell, which the turn context names: PowerShell on Windows, zsh or bash on
    macOS"); the tool list stays identical for every device (prompt cache, `docs/claude-code.md`);
  - the risk rating picks the rules by the device's `shell_kind`: PowerShell rules as now for
    `powershell`/`pwsh` (and for a device the step's list doesn't know, as before); for
    `zsh`/`bash`, `policy/shell_risk.classify` (the rules `run_shell` uses, reused, not copied)
    raised to dangerous by a short list of macOS commands (`osascript`, `defaults write`/`delete`,
    `launchctl`, `diskutil erase…`, `csrutil`, `spctl`, `tccutil`, `security
    delete-…`/`dump-keychain`/`find-…-password`, `dscl`/`sysadminctl`, `pmset`, `nvram`,
    `systemsetup`, `networksetup`, `shutdown`/`reboot`/`halt`), plus a POSIX network check for
    `contacts_people`;
  - the shell's transcript prompt is `PS name>` for PowerShell and `name%` for zsh/bash;
  - a device the step's list didn't know is rated as PowerShell (as before); if it turns out
    to have zsh/bash, or its shell changed since the step began, `run()` sends nothing and
    asks the model to call the tool again (then rated by the right rules);
  - `press` takes `Cmd` (`cmd+s` → `Cmd+s`).
- `tools/builtin/code.py` assumed nothing about paths; only its texts that said "Windows" were
  neutral already. A test pins that a macOS job's `/Users/…` paths go through unchanged.
- No migration (the values live in Valkey). No HTTP API change.

## 5. Core changes (`desktop/src/Anemo.Desktop.Core`)

A refactor commit first, with no behaviour change on Windows and every existing test green:

- `Platform/DesktopPlatform.cs`: what differs per OS as data: the wire name, the display name
  ("Windows"/"macOS"), the shell's name for messages, the secure-screen message, the code
  folders' defaults, whether `Cmd` is a key modifier, whether job command lines go through
  cmd.exe. `DesktopPlatform.Windows` holds today's values; `DesktopPlatform.MacOS(home)` the Mac's.
- `IShellHost.FindPowerShell()` becomes `FindShell()` returning `ShellProgram(Path, Kind)`;
  `CommandProcessor.ShellStartFor` builds PowerShell's arguments as before, or zsh/bash's.
- `ICodeHost.StartDetached(DetachedStart)` becomes `StartJob(JobLaunch)`; the Windows host
  turns it into the same `cmd.exe` line as before (`WindowsJobCommand`, in Core, tested).
- Defaults of the jobs and projects folders come from the platform.

Then the additions: `hello.platform` and `offer.shell_kind`; `Cmd` in `press` on macOS;
macOS key refusals; `DisplayLayout` (D4); `PosixPath` (finding programs on PATH without
relative entries); `MacKeyCodes` (virtual keys to macOS key codes).

## 6. The macOS host (`desktop/src/Anemo.Desktop.Mac`)

```
Program.cs                 single instance, logging, starts Avalonia; AppPaths
                           (~/Library/Application Support/Anemo Desktop: settings, logs, code-jobs.json)
App.axaml(.cs)             the Avalonia application (no main window)
Native/                    the P/Invoke declarations, one file per framework: ObjC (+ Blocks),
                           CoreFoundation, CoreGraphics (+ ImageIO), Accessibility, Keychain,
                           Carbon (hot keys, secure input), Posix (posix_spawn, kill)
Platform/MacDesktop.cs     windows (CGWindowList), focus, the "secure screen", the focused control
Platform/AxTree.cs         the Accessibility tree of a window → Core's UiTree; AxElement (IUiElement)
Platform/ScreenCapturer.cs ScreenCaptureKit (SCShareableContent, SCScreenshotManager), stitching, PNG
Platform/MacInput.cs       CGEvent mouse, keys and scroll; typing by CGEventKeyboardSetUnicodeString
Platform/MacServices.cs    apps and URLs (NSWorkspace, open), clipboard (NSPasteboard), zsh, the
                           PATH for children, the Keychain token protector
Platform/MacCodeHost.cs    gh/git runs, posix_spawn of jobs, process group kill; MacProcessProbe
Platform/Permissions.cs    Screen Recording and Accessibility: check, ask, open System Settings;
                           LoginItem (SMAppService)
Platform/HotKeys.cs        Carbon RegisterEventHotKey for Stop and Share
UI/MenuBarApp.cs           the menu bar item and its menu, wiring (the Windows TrayApp's counterpart)
UI/SettingsWindow, PermissionsWindow (.axaml); UI/Small.cs: icons, notices, the indicator
mac/Info.plist, mac/Entitlements.plist, mac/build-app.sh
```

Requirements: macOS 14 Sonoma or later (ScreenCaptureKit's `SCScreenshotManager`), Apple
Silicon. Files: settings and logs in `~/Library/Application Support/Anemo Desktop/`, the token
in the Keychain, the shell's folder `~/AnemoWork`.

## 7. CI and release

- `ci.yml`: the existing *Windows client* job (Linux) builds the whole solution, the Mac host
  included, and runs every Core test. A new **macOS client** job on `macos-15` (Apple Silicon)
  builds the Mac host for `osx-arm64`, runs the Core tests and the Mac smoke tests
  (`tests/Anemo.Desktop.Mac.Tests`: the frameworks and Objective-C classes load, a job is
  started with `posix_spawn` with its files as stdio in its own process group and the group,
  grandchild included, is ended and reaped, a hand-built block is called by Objective-C, zsh
  runs with the augmented PATH, the Keychain round trip under a throwaway service name, the
  runner's real displays in points, the clipboard, the Applications list), runs
  `build-app.sh` (ad-hoc signed) and checks the bundle with `codesign --verify`, and runs the
  bridge's `node --test`. Screenshots and Accessibility can't be tested there (no permission on a
  hosted runner).
- A **bridge** step in the same macOS job and in the Linux desktop job runs `node --test bridge/`.
- `release.yml`: the desktop release also builds `Anemo-Desktop-macos-arm64.zip` on
  `macos-15`; it signs with Developer ID and notarizes (`xcrun notarytool submit --wait`,
  `xcrun stapler staple`) when the six secrets are set, else ad-hoc signs and says so in the
  notes. A dry run (PR or *Run workflow*) builds it as an artifact.

## 8. Tests

- Backend: `hello.platform` / `offer.shell_kind` stored and read back, defaults for old clients
  and for an old hash, unknown values; the device line; `computer_shell` rated by PowerShell
  rules on Windows and POSIX rules on a Mac (`rm -rf ~` dangerous on zsh, `Remove-Item`
  dangerous on PowerShell, `ls` safe on zsh); the description doesn't name PowerShell; a
  macOS job's paths are stored as they came.
- Core (run here and on Linux/macOS CI): the refactor keeps all 458 tests; `JobLaunch` →
  `cmd.exe` line identical; zsh/bash shell starts; hello/offer fields; `Cmd` and the macOS
  refusals; `DisplayLayout` (1×, 2×, mixed, negative origins, window capture, the fit);
  `PosixPath`; `MacKeyCodes`; Code job defaults on macOS.
- Mac smoke tests (macOS CI only, skipped elsewhere): §7.
- Bridge: `node --test` (job id format, folder files, meta.json fields, start with a fake
  `claude`, status/list/log, cancel ends the tree, project resolution).

## 9. What is not tested (needs a Mac)

Everything that needs a logged-in macOS desktop and the two permissions: screenshots, the
Accessibility tree, clicks/typing/keys/scroll landing where they should, Retina mapping on a
real screen, windows and focus, `open`, the clipboard, the menu bar item and windows, the hot
keys, the indicator, SMAppService, the Keychain in the user's login keychain, permission
prompts and revocation, updates losing permissions, Claude Code jobs started from Anemo with
the real `claude`, and the notarization path (no Apple Developer account yet). The checklist
`09-desktop-macos-mac-testing.md` covers them, in order.

## 10. For Artem to decide

- An Apple Developer account (99 USD/year) for Developer ID signing and notarization: without
  it every update needs the permissions granted again and Gatekeeper asks on the first start
  (right-click → Open, or System Settings → Privacy & Security → Open Anyway).
- Whether to replace `C:\anemo-bridge\cc.ps1` on this VM with `bridge/cc.mjs`
  (`node bridge/cc.mjs …`); the bridge was not switched over by this work.
- An Intel build (`osx-x64`), if any Mac in the family is an Intel one.
