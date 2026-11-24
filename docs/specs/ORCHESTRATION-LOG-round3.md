# Orchestration log: round 3 (roadmap, voice mode, scripts, macOS desktop)

Whoever resumes this work continues from here. Inputs: the round's brief (2026-11-24),
`CONTRACTS-round3.md`, `CLAUDE.md`, the docs named there. Rules that hold throughout:
every branch from `origin/main`; one worktree, branch and pull request per workstream;
nothing merged into `main` by the agents; every sub-agent runs on Claude Opus 5.5.

## Where things are

- Checkout: `C:\dev\anemo` (Windows 11 VM, Git Bash; no Docker, no `make`, no WSL). Left
  on a detached `origin/main` (the earlier local branch `fix/code-job-mobile` was already
  merged as #75).
- Worktrees: `C:\dev\anemo\.worktrees\<branch name>` (git-ignored via
  `.git/info/exclude`), so the work stays inside the project folder.
- Local toolchain: `C:\dev\anemo\.local-env\` (portable Postgres + pgvector, a
  Redis-compatible server, a Python 3.13 venv, .NET 8, JDK 17 + Android SDK, Deno), set
  up by a helper agent at the start of the round; see its `README.md`.

## Status

| Id | Workstream | Branch | Status |
| --- | --- | --- | --- |
| A | Roadmap refresh (orchestrator) | `feat/roadmap-refresh` | #76, open (docs only) |
| B | Android voice: wake-word cue, voice mode | `feat/voice-mode-android` | #78, merged |
| C | Scripts under Automations | `feat/automation-scripts` | #82, merged |
| D | Anemo Desktop for macOS | `feat/desktop-macos` | #81, merged |

## Wave 0 (orchestrator)

Audit findings that shaped the contracts:

1. **No activity log with provenance and undo exists.** There are an audit log (security
   actions), actor provenance on documents / tasks / events, run timelines, the
   automation runs' `runs.changes` list, file revert and the trash. Decided: no new table
   this round; scripts run as automation runs (so provenance and changes come for free),
   voice mode on/off goes into the audit log (CONTRACTS-round3 §1).
2. **Voice today** (`android/`): one wake word = one turn; the 5-minute follow-up window
   only sends the last chat id, it never reopens the microphone. The cue tones use
   `ToneGenerator(STREAM_MUSIC)`: they follow media volume, which is why "was it heard?"
   is unclear when media volume is low. TTS already uses `USAGE_ASSISTANT`.
3. **Devices assume Windows**: `device.offer` has `shell: bool` only; `computer_shell` is
   described and risk-rated as PowerShell; `code_*` and the job folder default to
   `C:\anemo-bridge\jobs` / `C:\dev`. The client is C# / .NET 8 (`desktop/`), with a
   platform-free core (`Anemo.Desktop.Core`) and a Windows host (`Anemo.Desktop`).
   `cc.ps1` itself is not in the repo (it lives on the VM at `C:\anemo-bridge\cc.ps1`).
4. **No separate tool executor**: the per-call policy/approval logic is inside
   `runtime/agent.py` `AgentRun`; scripts must reuse it, not copy it (CONTRACTS §2).
5. Latest migration `0074_code_job_starters`; only C should add migrations.

## What happened

- **First launch failed.** The workers and the toolchain helper were started as
  background agents and the orchestrator ended its turn; in a headless `claude -p` run
  background tasks are killed ~10 minutes later, so all four stopped mid-work (B had its
  spec, C its spec and a refactor, D nothing). Rule since then (now in the VM's
  CLAUDE.md): sub-agents run in the foreground, several Agent calls in one message.
- **The round ran twice for a while.** A second orchestrator session ("anemo-b6")
  resumed the same round; for a time two C agents edited the same worktree. They
  noticed, the second one stopped (it left notes in the worktree and `_progress/`), and
  this session finished C, D and the log.
- **Local toolchain** (`C:\dev\anemo\.local-env\`, not in the repo): portable Postgres 16
  + pgvector and Redis 8 on localhost, a Python 3.13 venv, .NET 8, JDK 17 + Android SDK
  35, Deno 2.9.8. The backend is Linux-only in places; two local-only shims make it
  testable here (POSIX `os.O_*` flags; `safe_fs` replaced by pathlib in a pytest plugin,
  so the symlink-race protection is only tested in CI). Postgres uses `trust` auth
  (localhost only; the password file had a trailing CR). Each workstream used its own
  test database name: two runs on one name break each other.
- **Merges** (by Artem, while the orchestrator waited for a usage-limit reset): #78 (B),
  #81 (D), plus #77 and #79 from other sessions. C then needed a merge of `main`
  (registry and presets: both sides kept; migration renumbered to 0077 after 0075 and
  0076 landed) and a fix found by CI's e2e job: the worker image had Deno, but scripts
  failed with "No such file: deno". Fixed by resolving Deno's full path on the worker's
  PATH, `DENO_PATH=/usr/local/bin/deno` in the image, and a `RUN deno --version` as the
  app user at build time, so a broken image fails its build instead of the first run.

## Contract deviations (accepted)

- B: every recording is first only transcribed (`POST /api/voice/transcripts`), the
  phone matches commands on that text in code, and sends the rest as text to
  `/voice/turns` (new optional `text`, `voice_mode`, `keep_chat`). More than §3 listed;
  it is what makes "matched in the app, never by the model" true while the phone does
  no speech recognition itself. The notification's Status button gave way to *Voice
  mode* (Android shows three buttons).
- D: the server stores `platform` and `shell_kind` in the offer hash as agreed; Anemo
  Desktop keeps its own C# job start (`bridge/cc.mjs` is the cross-platform bridge for
  agents that start jobs from a shell, same folder format). Version 1.4.0 (1.3.0 was taken by #77).
- C: scripts run as automation runs (provenance from the existing actor context, as
  §1 decided); the migration is `0077_automation_scripts` instead of 0075.

## Open for Artem

- Voice: run `android/MANUAL-TESTS.md` (new tests for the cue and voice mode) on the
  Xiaomi; if the cue is silent, switch its stream to alarm (one line in `ToneCues.kt`).
  `voice_stop` is allowed without asking by default.
- macOS: an Apple Developer account and the six signing secrets (until then, every
  update of the ad-hoc build loses Screen Recording and Accessibility); keep or change
  the bundle id `app.anemo.desktop` before the first signed release; run the 54-step
  checklist on a borrowed Mac; whether this VM's agents move from `cc.ps1` to
  `node bridge/cc.mjs`.
- Scripts: approving a script's code is the only way it runs; read spec 08's security
  section before enabling the first agent-written one.
- An activity log with undo is still not built (roadmap → *Next*).

## Close (2026-11-24)

- #78, #81 and #82 merged into `main` (by Artem), each with all CI jobs green, including
  the end-to-end job and the new macOS job. #76 (this log, the roadmap, the contracts)
  is open and merges cleanly onto `main` at `230ae27`.
- Not run anywhere: Anemo Voice 1.1.0 on a phone, Anemo Desktop on a real logged-in Mac
  (CI's macOS runner ran Core's tests, smoke tests and one real screenshot only),
  Developer ID signing and notarization, an agent-written script approved and run on the
  real install.

