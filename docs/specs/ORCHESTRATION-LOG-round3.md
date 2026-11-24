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
| A | Roadmap refresh (orchestrator) | `feat/roadmap-refresh` | see below |
| B | Android voice: wake-word cue, voice mode | `feat/voice-mode-android` | see below |
| C | Scripts under Automations | `feat/automation-scripts` | see below |
| D | Anemo Desktop for macOS | `feat/desktop-macos` | see below |

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
