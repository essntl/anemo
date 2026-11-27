# Spec: permission profiles per device

*Build queue item 1. Written 27 Nov 2026 against main `dbcc6a2`, based on the design Artem approved in the [roadmap](/documents/01a1f88d-056f-7724-bc7a-2acee517d6e1) ("Permission profiles per device"). **Status: approved by Artem 27 Nov 10:00.** After approval it goes into the repo as `docs/specs/25-device-permission-profiles.md` and one Claude Code job builds it.*

## 0. Workspace scratch folder (sandbox, `run_shell`)

**Problem:** agents make temporary files and folders in the workspace with `run_shell` (clones, build output, test files) and then `rm -r` them. `shell_risk.py` rates every `rm -r` as dangerous whatever the path, so Artem has to approve the cleanup each time. `/tmp` in the sandbox doesn't survive between calls, so agents use the workspace.

- **A workspace folder `scratch/`** (top level, created on start). It's listed in Files, but collapsed and marked "temporary". A project chat uses `scratch/<project folder>/`.
- **Inside `scratch/`, `run_shell` writes and deletes never ask**, `rm -rf` included. `shell_risk.py` becomes path-aware for deletes:
  - `rm`, `rmdir`, `find … -delete` and `git clean` whose path arguments are all literal and, resolved against the command's working folder (`cwd` plus literal `cd`), all fall inside `scratch/` are rated *moderate* instead of *dangerous*.
  - Symlinks are resolved first.
  - Globs only count if their literal prefix is inside `scratch/`, and a variable or `$(...)` in a path keeps the rating *dangerous*.
  - A delete of `scratch/` itself, or of anything outside it, stays as today.
- **Auto-clean:** the worker deletes files in `scratch/` older than 7 days (a setting), so nobody has to clean up.
- **The system prompt** gets one line: "Throwaway files (clones, build output, experiments) go in `scratch/`; it is cleaned automatically, and deleting inside it needs no approval."
- **Tests:** a table in `test_shell_risk.py`:
  - inside → moderate;
  - `../` out of scratch → dangerous;
  - a symlink out → dangerous;
  - `rm -rf scratch` → dangerous;
  - `rm -rf $X` → dangerous.

This is small and independent, so it's PR group 0 of the job.

## 1. The problem, in the code as it is today

- A device has `trust: watched | trusted` (`backend/app/features/devices/models.py`). On a watched device every `computer_act` asks and `computer_shell` is blocked. On a trusted device the shell follows the global *Agent Permissions* level for `computer.shell`.
- The server rates each PowerShell command with **regexes** (`rate_powershell` in `tools/builtin/computer.py` on top of `policy/shell_risk.py`). Any `Remove-Item`/`rm`/`del` anywhere counts as **dangerous**, whatever the path. That's why deleting a log file in `C:\dev` asks every time.
- "Allow for this run" grants (`runs/agent_router.py: grant_for`) only last for one run, and for the shell they have no useful folder, because the resource is the device, not a path.
- Anemo Desktop only checks *whether* the shell is on (`RequireShellAllowed`). It runs whatever the server sends. It already has a good path checker for file transfers (`Files/FileRules.cs`: follows links and junctions, hidden folders, AppData, Startup, its own data folder), which this spec reuses.
- The activity log (`features/activity`, spec 19) records workspace changes with undo. It doesn't record device actions yet.

## 2. What we're building

1. **A permission profile per device** instead of `trust`.
2. **Work folders**: where an agent may do anything without asking. Everything else is read-only, and protected folders always ask or are refused.
3. **A PowerShell analyser in Anemo Desktop**, built on PowerShell's own parser (the AST). It turns a command into *reads / writes / deletes / runs programs at these paths*, or *can't tell*.
4. **Enforcement on the device.** The server decides when to ask, but the device re-checks every command against its own copy of the profile and refuses anything that breaks it.
5. **Approval buttons**: once, this folder (adds it as a work folder), the next hour.
6. **An optional relevance check** by a separate cheap model, which can only turn an *allow* into an *ask*.
7. **Recycle Bin deletes** in work folders that want them, and **every device action in the activity log**.
8. **Automation rules**: the device profile applies, session grants don't, and "Unrestricted" for automations needs its own switch.

9. **A scratch folder in the workspace** (§0 below), so agents' throwaway files and folders in the sandbox stop asking.

**Decided by Artem 27 Nov:** full remote management. Nothing ever needs a click on the computer itself: profiles, work folders and grants are all managed from Anemo (the web UI and the approval prompt), and a change applies at once. Folders are simply **work folders** (an agent may do anything there) and everything else is **read-only** unless the device is Unrestricted. The approval prompt has three choices: **once**, **this folder**, **the next hour**.

Out of scope: a macOS analyser (zsh/bash keep today's regex rating, see §10), phones, browser permissions and MCP tools.

## 3. Profiles

A profile is a named, reusable set of settings that several devices can share. Each device has exactly one.

**Categories.** Each one is *allow*, *ask* or *deny*:

| Category | Covers | Today's capability |
|---|---|---|
| `see` | screenshots, reading windows | `computer.see` |
| `act` | clicks, typing, keys, opening programs, clipboard | `computer.act` |
| `shell` | `computer_shell` commands, refined by the work folders (§4) | `computer.shell` |
| `files` | `device_file_get` / `device_file_put` | `device.files` |
| `code` | starting and cancelling Claude Code jobs | `code.*` start/cancel |

**Presets.** They're built in and can't be edited, but each one can be copied into a custom profile:

| | see | act | shell | files | code | Scopes |
|---|---|---|---|---|---|---|
| **Unrestricted** (VM) | allow | allow | allow, any path | allow | allow | the whole computer is a work folder, except the hard floor (§4.3) |
| **Scoped** (Main PC) | allow | ask | by work folders | by work folders | ask | work folders as configured (§4); everything else read-only |
| **Watched** | ask | ask, every time | deny | deny | deny | none |

**The global ceiling still applies.** The Agent Permissions policy and an agent profile can make things stricter than the device profile, never looser. That's the existing "most restrictive wins" rule in `policy/engine.py`. The device profile becomes one more layer there.

**Migration (no silent loosening).** `watched` becomes **Watched**. `trusted` becomes a generated profile, **Trusted (legacy)**, that behaves exactly like today: the shell follows the global level, with the old regex rating. After the upgrade, Artem picks Unrestricted for the VM and Scoped for the Main PC himself. The `trust` column is kept for one release and derived from the profile (Watched → watched, otherwise trusted), so older code and the turn-context line keep working. Then it's dropped.

## 4. Work folders

### 4.1 Work folders and read-only

Each device has a list of **work folders** (full paths). In a work folder an agent may do anything without asking: read, write, delete, and run programs and scripts there or with it as the working folder (`git`, `dotnet`, `npm`, `python`, `.\build.ps1`, …).

**Everywhere else is read-only**, unless the profile is Unrestricted:
- Reading and listing files goes through, except in protected folders (§4.3).
- Writes, deletes and running programs that aren't known to be read-only **ask**.

Each work folder can also have **Recycle Bin** turned on (it's on by default). Deletes there then go to the Recycle Bin instead of being permanent (§8).

Work folders nest, so a work folder inside another one is fine. They're edited in Settings › Devices › *device* › Permissions, or added from the approval prompt ("This folder", §6.2).

### 4.2 Defaults for the Main PC (Scoped)

- `C:\dev`
- `%USERPROFILE%\Downloads` (with the Recycle Bin)
- `%USERPROFILE%\AnemoWork` (the shell's working folder)
- `%TEMP%`

### 4.3 Protected folders

These are checked **before** the work folders, and a work folder can't override them:

- **Hard floor, deny on every profile, Unrestricted included:** Anemo Desktop's own data folder (its token, settings and *the profile copy itself*) and its install folder. Otherwise an agent could edit its own permissions.
- **Deny by default** (in Scoped; can be switched to ask in the device's settings in Anemo): `.ssh`, `.aws`, `.gnupg`, browser profile folders (Chrome, Edge, Firefox under AppData), Windows Credential Manager / DPAPI folders (`AppData\Roaming\Microsoft\Credentials`, `Protect`), the Startup folders, PowerShell profile folders.
- **Ask by default:** `C:\Windows`, `C:\Program Files*`, `C:\ProgramData`, the rest of `AppData`, the user profile root itself (a recursive delete of `C:\Users\artem` must never slip through because a child folder is a work folder), and the root of every drive.

`FileRules.cs` already knows most of these. The protected list is shared by file transfers and the shell.

### 4.4 Resolving a path

- Paths are normalised: `/` → `\`, case-insensitive, `..` collapsed. Then every link and junction on the way is followed, the way `FileRules.Check` does it. **The real target is what gets matched.** A junction in `C:\dev` that points to `C:\Windows` counts as `C:\Windows`.
- Relative paths are resolved against the working folder, which is tracked through literal `Set-Location`/`cd`/`Push-Location` calls in the same command.
- `$HOME`, `$env:USERPROFILE`, `$env:TEMP`, `$env:TMP`, `$env:LOCALAPPDATA`, `$env:APPDATA` and `$PWD` are expanded. **Any other variable used as a path makes the command *can't tell*.**
- Wildcards are fine when the literal part before the first wildcard is inside the work folder (`C:\dev\anemo\logs\*.log`). `-Recurse` deletes are matched on their root folder, and that root must itself be inside a work folder, not just its children. Deleting a work folder itself asks.
- **Pipelines:** `Get-ChildItem <literal path> [-Recurse] [-Filter …] | Remove-Item` uses the `Get-ChildItem` path as the delete target. This is the most common delete pattern, so it has to work. Pipelines from anything else into a write or delete cmdlet are *can't tell*.

## 5. The PowerShell analyser (Anemo Desktop)

### 5.1 How it parses

It uses `System.Management.Automation.Language.Parser.ParseInput`. There are two ways to host it:

- **(a) Recommended:** a small long-running helper `powershell.exe -NoProfile` started by Anemo Desktop, which parses on request over stdin/stdout and returns JSON. It costs ~5–20 ms per command after the first, adds nothing to the installer, and uses the same parser version as the shell that runs the command.
- (b) Embed `Microsoft.PowerShell.SDK`. This gives in-process parsing, but adds roughly 30–60 MB to the Desktop app and can differ from the installed PowerShell.

The helper only **parses**. It never runs the input. Parse errors make the result *can't tell*.

### 5.2 What it returns

```json
{ "verdict": "allow" | "ask" | "deny",
  "effects": [ {"kind": "read|write|delete|run", "path": "C:\\dev\\anemo\\logs", "recursive": true,
               "work_folder": "C:\\dev", "recycle": false} ],
  "unknown": [ "variable $p used as a path" ],
  "rule": "delete inside work folder C:\\dev",
  "network": true }
```

`rule` is the one sentence shown in the approval dialog and the activity log. It always names the rule that decided.

### 5.3 Rules, in order

1. **Hard floor or a deny-protected folder touched by write/delete/run:** deny.
2. **Something it can't analyse:** *ask*, every time, and no grant covers it except "this exact command for this chat" (§6). This includes:
   - `Invoke-Expression`/`iex`, `-EncodedCommand`, `[ScriptBlock]::Create`, `Add-Type`
   - the call operator or dot-sourcing on anything but a literal name or path
   - .NET method calls that change things (`[IO.File]::Delete`, `.Delete()`, `[IO.Directory]::…`, `WebClient.DownloadFile`)
   - download-then-run, `Start-Process -Verb RunAs`
   - registry writes, services, scheduled tasks, firewall, users, disks, `bcdedit`, `Set-ExecutionPolicy`, Defender settings
   - `Invoke-Command`/remoting
   - variables as paths (beyond the list in §4.4), splatting into write or delete cmdlets
   - unknown native programs with path arguments, and `cmd /c` with anything non-literal

   The existing `_PS_DANGEROUS` list is the starting set. It now runs against AST nodes instead of raw text, so a string that merely contains "rm" no longer trips it.
3. **Read-only commands** run anywhere outside deny-protected folders: verbs `Get`, `Test`, `Select`, `Measure`, `Format`, `Out-String`, `Out-Host`, `Where-Object`, `Sort-Object`, `Group-Object`, `Compare-Object`, `ConvertTo-*`/`ConvertFrom-*`, `Resolve-Path`, `Split-Path`, `Join-Path`, plus read-only natives (`git status/log/diff/show/branch`, `where.exe`, `whoami`, `ipconfig`, `systeminfo`, …). Script blocks (`ForEach-Object { … }`, `Where-Object { … }`) are analysed recursively, so their contents count too.
4. **Write, delete or run effects** are each matched against the protected folders, then the work folders. The command gets the most restrictive result over all its effects: *ask* when any effect lands outside a work folder.
5. **Network** (today's `_PS_NETWORK`, on AST command names) only sets `network: true`. It doesn't change the verdict. It still marks the action as `contacts_people` for automations, as today.

On **Unrestricted**, the analyser still runs (for the log and the hard floor), and everything except rule 1 is *allow*.

### 5.4 The corpus test

There's a table test in `desktop/tests` with at least 150 commands and their expected verdict and rule. It must include the ways people get around checks:

- aliases (`ri`, `rm`, `del`, `erase`, `rd`) and case games (`ReMoVe-ItEm`)
- backtick escapes (``Re`move-Item``), splatting (`@p`), `& 'Remove-Item' x` (a literal call: resolvable), `& ("Re"+"move-Item")` (can't tell)
- here-strings, `;` and `&&` chains, nested `powershell -c "…"` (analysed recursively, at most 3 levels, otherwise can't tell)
- `cmd /c "del /s /q C:\…"`, `Get-ChildItem … | Remove-Item -Recurse`
- junctions out of a work folder (temp junction fixture), `..\..\` out of a work folder, UNC paths (`\\server\share`: always ask), the drive root `C:\`, `-LiteralPath` vs `-Path`, and `-WhatIf` (still analysed as the real thing)

## 6. Decisions and grants

### 6.1 Flow of one `computer_shell` call

1. In `actions()`, the server rates the command as today (regex) so it has a summary.
2. In `run()`, before sending, the server sends **`shell.analyze`** (a new device-contract message) and gets the analysis back. A timeout of 3 s, or an old Desktop that doesn't know the message, falls back to today's regex behaviour under the **Trusted (legacy)** rules, and the approval dialog says so.
3. The server combines the device verdict with the policy layers, grants (§6.2) and the relevance check (§7). Most restrictive wins.
4. If the result is *ask*, there's an approval with the analysis's `rule` sentence and the new buttons.
5. The server sends `shell` with either `"auto": {"rule": …}` or `"approval": {"id": …, "scope": "once|folder|hour"}`.
6. **The device analyses again** (the command text is identical, so the result is cached by hash) and refuses when:
   - the verdict is *deny*;
   - the verdict is *ask* and there's no approval id;
   - the profile copy is older than the version the server says it used. The device then asks for a resync and the server retries once.

**What device enforcement protects against, honestly:**
- **It stops:** server bugs and a stale server-side profile. The hard floor, which is fixed in Anemo Desktop's code, also holds against everything.
- **It doesn't stop:** a compromised server or Anemo account. Full remote management means that whoever controls Anemo controls the device's profile. Artem accepted this on 27 Nov: Anemo's login is the boundary.

### 6.2 The approval prompt: once, this folder, the next hour

| Button | Stored where | Covers |
|---|---|---|
| **Once** | — | this call |
| **This folder** | the device's profile | adds the folder as a work folder on that device, until Artem removes it in settings |
| **The next hour** | server | every write, delete or run in that folder on that device, in every chat, for 60 min |

- **Which folder** the button means is shown in the prompt: the deepest folder that covers all the effects, e.g. `C:\Users\artem\Documents\notes`. The prompt also has a small "use the parent folder" choice.
- **Protected folders:** "This folder" and "The next hour" never cover deny-protected folders or the hard floor. In *ask*-protected folders (Windows, Program Files, the user folder root, drive roots) only **Once** works, so a click can't make `C:\Users\artem` a work folder by accident. Artem can still add one there in settings on purpose.
- **Commands the analyser can't read** (§5.3 rule 2) only get **Once**, plus "**this exact command** for the next hour", keyed by the command's hash.
- Today's "allow for this run" stays for non-device tools.

## 7. Relevance check (only ever stricter)

- **When it runs:** on shell commands the deterministic rules *allowed* with a **delete** effect, a **recursive** effect, or a **write** to a folder the chat hasn't touched yet. It doesn't run on reads, or on Unrestricted unless it's switched on there.
- **What it sees:**
  - the user's last 3 messages in the chat, or for an automation its prompt;
  - the command, the analysis effects, and the device name.
  - **No tool results, web pages or file contents.** That way a prompt injection in a page can't argue with it.
- **What it answers:** `{"ok": true}` or `{"ok": false, "why": "…"}`. A `false` turns *allow* into *ask*, with its `why` shown in the dialog ("deletes C:\Users\artem\Pictures\2024 while the task is about CI logs"). It can't do anything else.
- **The model:** a setting (default: the cheapest configured model, e.g. Haiku), with a 4 s timeout. On a timeout or error it **fails open**: the allow stands and the log notes "relevance check unavailable". It's an extra layer, and failing closed would bring back the nagging.
- **Defaults:** on for Scoped, off for Unrestricted and for Trusted (legacy). It's a switch per profile.

## 8. Recycle Bin deletes

- **Through Anemo's own tools:** `device_file_*` and future file tools delete to the Recycle Bin (`Microsoft.VisualBasic.FileIO.FileSystem.DeleteFile/DeleteDirectory` with `SendToRecycleBin`).
- **In the shell:** when every delete effect of a command is in work folders with *Recycle Bin* on, Anemo Desktop starts the shell with a prelude that defines a `Remove-Item` proxy function (plus the `rm`/`del`/`ri`/`erase`/`rd`/`rmdir` aliases) which recycles instead.
  - **It's not a security boundary.** It's only there to make normal deletes reversible, and the analyser already decided the delete is allowed.
  - `cmd /c del`, `git clean` and the like stay permanent. The activity log entry says "permanent" for those.
- **Size:** files over the Recycle Bin's limit are refused with a clear error rather than deleted permanently.

## 9. Activity log and automations

- **Every device action goes into the activity log** (spec 19): shell commands, file transfers, act and code start/cancel. That includes auto-allowed ones.
  - Each entry has: device, command (first 2,000 characters), working folder, verdict, `rule`, grant used, relevance result, exit code, and the run/chat.
  - Not undoable, except recycled deletes, which get a "Restore from Recycle Bin" action (phase D, if cheap; otherwise later).
  - A filter on the Activity page: "On computers".
- **Automations:**
  - They use the device's profile and its work folders, but never the 1-hour grants.
  - "This exact command" grants don't apply to them either.
  - On an **Unrestricted** device, an automation run is treated as **Scoped with the same work folders** unless the device's **"Unrestricted for automations"** switch is on. It's off by default. Artem can turn it on for the VM.
  - `contacts_people` keeps working as today.

## 10. Data, protocol and UI

**Database (one migration):**
- `device_profiles`: id, name, preset (null for custom), categories JSONB, work folders JSONB `[{path, recycle, added_from}]`, protected overrides JSONB, `relevance_check` bool, `version` int (bumped on every change), timestamps.
- `devices.profile_id` (FK, not null after migration) and `devices.automations_unrestricted` bool.
- `device_grants` (the 1-hour grants): id, device_id, expires_at, folder, command_hash null, created_by approval id.

**Device contract** (`docs/device-contracts.md`, new section):
- `profile.sync` (server → device: the full profile + version). The device stores it in its data folder.
- `shell.analyze` request/response (§5.2).
- `shell` gains `auto` / `approval` / `profile_version`.
- Desktop reports `capabilities: ["shell.analyze", "profiles"]` in its hello message, so the server knows when to fall back.

**Fully remote (decided by Artem).** Every profile change is made in Anemo and applies at once through `profile.sync`. Nothing needs a click on the computer. Two things keep that safe:
- **Agents can't change permissions.** `settings.*` is on the engine's hard floor, profile and work-folder edits are their own `settings.devices` capability, and "This folder" only comes from Artem's own click in an approval.
- **The agent can't edit the device's copy of the profile through the shell**, because Anemo Desktop's data folder is on the hard floor.

**Optional on-site confirmation (a toggle in Anemo Desktop, off by default).** This is a setting in Anemo Desktop's own settings window, "Confirm loosened permissions on this computer". It can only be switched on or off there, never from the server.
- **When it's on,** a `profile.sync` that loosens the device's permissions waits for a click in a Windows notification from Anemo Desktop before it applies ("Anemo wants to make C:\Users\artem\Documents a work folder. Allow?"). Until then the device keeps enforcing the old profile, and the web UI shows "waiting for confirmation on *device*".
- **What counts as loosening:**
  - a looser preset;
  - a new work folder;
  - a deny-protected folder switched to ask;
  - the relevance check turned off;
  - "Unrestricted for automations" turned on;
  - a "This folder" click from the approval prompt.
- **What applies at once:** tightening, and 1-hour grants, which are temporary and enforced server-side only. With the toggle on, a 1-hour grant on an *ask* still works remotely.
- **When it's off** (the default, and Artem's choice for his devices), every change applies at once.

What this accepts with the toggle off: anyone who gets into Artem's Anemo account can loosen a device. That's the same as today, where they could already switch a device to trusted. Anemo's login is the boundary.

**Web UI:**
- Settings › Devices › *device* › **Permissions**: the profile picker, the category grid, the work folders (path, Recycle Bin, "added from approval on …", Remove), the protected folders (read-only, as the device reports them), the active grants with Revoke, and the automation switch.
- Settings › **Device profiles**: list, copy, rename, delete (only if no device uses it).
- **The approval dialog for device calls:** the `rule` sentence, the effects list (path + kind), the relevance reason if any, and the buttons Once / This folder / The next hour (§6.2).

**Turn context line:** `- Main PC: computer, profile Scoped (writes only in work folders), control allowed, PowerShell on`. Keep it one line and short, because it's in every request.

**macOS:** profiles and categories apply, but there's no analyser yet. On Scoped, every zsh/bash command that the regex rating marks moderate or dangerous asks. Read-only commands are allowed. It gets its own item later.

## 11. Build plan (one job, five PR groups, tested with `ci-remote.sh`)

- **0. Workspace scratch folder** (§0).
- **A. Backend model + migration + UI, behaviour unchanged.** Profiles, presets, the legacy profile, the device page, and the engine layer. Every existing test stays green and nothing loosens.
- **B. Desktop analyser + enforcement.** The parse helper, the analyser with the corpus test, `profile.sync`, `shell.analyze`, re-checking on `shell`, the hard floor, and the optional "Confirm loosened permissions on this computer" toggle (§10).
- **C. Grants + approval dialog.** Once / This folder / The next hour, the "exact command" grant, the revoke UI, and an e2e test with the fake device covering: delete in a work folder → no question, delete in Pictures → asks, "This folder" → next time no question, delete in `.ssh` → refused.
- **D. Relevance check, Recycle Bin, activity log, automations.**

The Desktop version goes up (minor). The Android app isn't touched.

## 12. Decisions

- **Decided by Artem, 27 Nov:**
  - Full remote management by default. An optional Anemo Desktop toggle (off by default, only switchable on the device) requires on-site confirmation for loosening.
  - Work folders plus read-only for everything else.
  - The prompt has Once / This folder / The next hour.
  - A scratch folder in the workspace.
- **Taken as recommended unless Artem objects:**
  - The parser runs as a long-running `powershell.exe` helper.
  - The relevance check fails open.
- **Approved by Artem 27 Nov 10:00 ("Go")**, including the default work folders in §4.2.

## 13. Implementation notes and deviations

Written by the job that built this spec; each PR group adds its own part.

**Group 0 (scratch folder)**
- *Globs:* `scratch/*` counts as inside (a glob can only match children of the folder before it), but a glob followed by more path (`scratch/*/../x`), a pattern starting with `.` (`.*` can match `..`), and brace expansion (`{a,../x}`) keep *dangerous*.
- *Working folder:* only `cd X && …` narrows it. After `;`, `||`, `&` or a subshell's `)` the `cd` may have failed or been undone, so the delete must be inside scratch for every folder seen so far; `cd $X`, `pushd`, `if cd …` make the folder unknown. Wrappers (`xargs rm`, `env -C`) keep the old rating.
- `find … -delete` counts only without `-exec`/`-ok`/`-fprint*` and without `-L`/`-H`/`-follow`; `git clean` only with plain `-C <literal>` before it (no `-c`, `--git-dir`, `--work-tree`).
- If `scratch/` itself has been replaced by a link, nothing counts as inside.
- *Files page:* the Files list is one folder at a time, so `scratch/` is a folder row (collapsed by nature), listed last with a "temporary" badge. The age is Settings › Workspace › "Keep scratch files" (`files.scratch_keep_days`, 7 days). Folders the clean-up emptied go too; an empty folder an agent just made stays until it is old.

**Group A (profiles, migration, UI; behaviour unchanged)**
- *Work folders, protected-folder overrides, the automation switch and the version live on the device, not on the profile* (`devices.work_folders`, `protected_overrides`, `automations_unrestricted`, `permissions_version`). Paths are per computer, and presets can't be edited, so "This folder" on a device that uses the Scoped preset must not change every Scoped device. The profile holds the category levels and the relevance switch. `profile.sync` sends the two together as the device's effective profile (`features/devices/profiles.py: effective`).
- Category levels are `allow`, `ask`, `deny`, `folders` (decided by the work folders: shell and files) and `policy` (no device layer: Trusted (legacy)). Until the device has the analyser (group B), `folders` is left to the policy, as Trusted (legacy) does (§6.1 fallback). So nothing is looser than a trusted device today.
- *Watched `see` is `policy`, not `ask`.* A watched device let the agent look as the Agent Permissions said, and §11 A asks for every existing test to stay green with behaviour unchanged. A custom profile can still set `see: ask`.
- A device profile's `ask` is never lifted by "allow for this run" (`engine.evaluate`); the one-hour grants of §6.2 come in group C.
- The turn-context line keeps "watched" / "trusted" for the two profiles the migration gives, so nothing changes for existing devices. Other profiles read `profile Scoped (writes only in work folders)`.
- Settings › Device profiles is a card on the Devices page, not a page of its own. Starting a Claude Code job asks when the profile's `code` is `ask`. Cancelling only stops work, so it follows the policy alone (the call names a job, not a device).
- Profile and permission changes need the password again (`require_recent_auth`), like the old trust level.

**Group B (Desktop analyser and enforcement, Anemo Desktop 1.10.0)**
- *When the device is asked:* the approval has to happen before `run()`. So `shell.analyze` is sent from a new `Tool.prepare()` hook, which the agent loop and the script runner call just before the permission decision, instead of from `run()`. The flow is otherwise §6.1: 3 s timeout, fallback to the old rules (the approval summary says "Anemo Desktop couldn't check this command"), `shell` with `auto` or `approval` plus `profile_version`, the device re-checks, and a stale copy is synced and the command tried once.
- *The risk the Agent Permissions see comes from the analysis* (no change: safe; an allowed change: moderate; ask or deny: dangerous), not from the regexes. Otherwise "Ask for dangerous actions" would keep asking about every `Remove-Item` in a work folder, which is the problem §1 describes. The global level still applies: with "Commands on your computers" at **Ask** (the default), everything still asks.
- *Reads in deny-protected folders are refused too.* Rule 1 lists write/delete/run, but §4.1 says reading goes through "except in protected folders", and reading `.ssh` or the Anemo token is exactly what must not happen. Reads in ask-protected folders (Windows, Program Files) go through.
- *A work folder inside an ask-protected folder holds for what is inside it.* %TEMP% is a default work folder and lies in AppData. Deleting the protected folder itself, or a parent of it, still asks. Deny-protected folders and the hard floor are never opened up by a work folder.
- *A delete that would take a protected folder with it counts as touching that folder* (`Remove-Item C:\Users\artem -Recurse` is refused: Anemo Desktop's data folder is inside).
- *Commands it doesn't know:* a cmdlet with a read-only verb (Get, Test, Select, Measure, Find, Compare, ConvertTo/From, Resolve, Split, Join, Show, Search, Read, Out, Wait) reads its path arguments. Any other cmdlet can't be told. A program it doesn't know runs in the working folder; with path arguments it can't be told. A list of system programs (reg, sc, schtasks, netsh, bcdedit, robocopy, …) can't be told either. `cmd /c` is read only for `del`, `erase`, `rd`, `rmdir`, `dir`, `type`, `md` and `echo`, without cmd's operators and `%` variables.
- *Hash and cache:* the device caches analyses by profile version, working folder and SHA-256 of the command.
- *The confirmation* is a Windows balloon notification; clicking it opens a Yes/No question. While a loosening waits, a `shell` decided with the newer version is refused as stale, so nothing new applies until it is confirmed. The settings page shows "Waiting for confirmation on <device>".
- *macOS (no analyser):* on Scoped, a zsh/bash command the regex rating doesn't call safe asks; read-only commands go through (§10).
- The corpus (`desktop/tests/…/PowerShellCorpusTests.cs`) has 190+ commands. It parses with Windows PowerShell 5.1 on Windows and pwsh 7 on the Linux CI. `&&` is a parse error in 5.1 and a chain in 7; the corpus entry asks on both.
