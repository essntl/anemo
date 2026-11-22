# Orchestration log: devices (voice on Android, Windows clients)

Whoever resumes this work continues from here. Inputs: `05-voice-android.md`,
`06-desktop-client.md`, `docs/device-contracts.md`, `CONTRACTS-devices.md`, `CLAUDE.md`.
Rules that hold throughout: never touch the live Anemo instance; nothing is merged into
`main`, pushed or deployed; at most 4 sub-agents at a time; every sub-agent runs on
Claude Opus 5.5 (`model: "opus"`).

## Where things are

- Integration branch: `integrate/devices` (from `main` at `737f0e5`).
- Checkout: `C:\Users\user\Desktop\anemo` (Windows 11, Git Bash; no `make`).
- Worktrees: `../anemo-<id>` on `feat/<id>`; progress notes in `../anemo-progress/<id>.md`;
  release artefacts go to `../anemo-artifacts/`.
- Throwaway stack: compose project `anemo-devices` (its own Postgres and Valkey). The
  `.env` in the checkout (not committed) is copied into each worktree. Backend checks:
  `sh ../anemo-progress/backend.sh <id> check` (see `CONTRACTS-devices.md` §10).
- Do not touch the Docker volumes and images named `ai-workspace*` or `essntl/anemo*` on
  this machine: they belong to an earlier local install, not to this work.

## Status

| Wave | Package | Branch | Model | Status |
|---|---|---|---|---|
| 0 | contracts, stubs, plan | `integrate/devices` | orchestrator (Claude Fable 5.2) | done; waiting for the user's OK |
| 1 | D1 devices core | `feat/d1` | Opus 5.5 | not started |
| 1 | D2 computer tools | `feat/d2` | Opus 5.5 | not started |
| 1 | V1 voice backend | `feat/v1` | Opus 5.5 | not started |
| 1 | W1 Windows client | `feat/w1` | Opus 5.5 | not started |
| 1 | A1 Android app | `feat/a1` | Opus 5.5 | not started (first free slot; see toolchains) |
| 2 | X1 end to end, docs | `feat/x1` | Opus 5.5 | not started (needs D1, D2, V1 merged) |
| 3 | integration, final report | `integrate/devices` | orchestrator | not started |

Merge order, whatever order they finish in: D1, V1, D2, W1, A1. After D1 merges, D2's
tests run against the real relay before D2 merges. Full suite after every merge. Every
package is reviewed by a fresh Opus 5.5 sub-agent that didn't build it.

## Wave 0

- Baseline on `main`: see "Baseline" below.
- The user added the two specs and the device contracts (they were not in the repo); the
  contracts file was put at `docs/device-contracts.md`, where the specs point.
- Commits use the repo's own author identity (set in this clone's git config only).

### Toolchains (this machine)

| Tool | Status |
|---|---|
| .NET SDK 8.0.428 | installed; see "Baseline" for the Windows-targeted publish check |
| JDK 17.0.12 | installed at `C:\Program Files\Java\jdk-17`, not on `PATH` and no `JAVA_HOME`: A1 sets `JAVA_HOME` itself |
| Android SDK, Gradle | **not installed** (the user's choice so far) |
| `make` | not installed; `../anemo-progress/backend.sh` runs the same commands |
| Docker, Python, uv, Node 24 | present |

### What the code map found (and what was decided)

1. The global `approval.requested` event carries only `{run_id, conversation_id}`; the
   wire event needs the approval's id, kind, summary, risk, question and options. Decided:
   D1's WebSocket builds the wire event from the database (CONTRACTS §3). No wire change.
2. There is no `approval.decided` event today (only `approval.resolved` on the run's own
   stream). Decided: V1 publishes a new global `approval.decided` from `decide_approval`;
   D1 forwards it. No wire change.
3. `voice.say` has to be published where a run ends (`runtime/agent_finalize.py`), so V1
   owns that hook; the global event carries `device_id` so D1 can filter without a query.
4. V1 needs to know which device is calling, and D2 needs devices by name, before D1's
   table exists. Decided: a stub `features/devices/service.py` (`by_name`,
   `by_token_id`, a `DeviceRef` protocol) on the integration branch, in addition to the
   three stubs the plan named.
5. Devices and Voice are Settings pages, so they are registered in
   `features/settings/sections.ts` (`SETTINGS_SECTIONS`), not in `navigation.ts` /
   `PageId` as the plan said: those list the app's own pages that can be switched off.
6. Both D2 (device lines) and V1 (voice note) add to the turn context in
   `runtime/agent_snapshot.py`. Decided: each adds its own lines; the orchestrator
   resolves the merge.
7. Spec 05 refers to "contract §3" for the phone's events; they are in §2 of
   `device-contracts.md`. A wrong reference only; nothing to decide.

### Open questions for the user

1. **Plan reviews on the phone.** The wire contract's `approval.requested` has kinds
   `action` and `question`; Anemo also has `plan` (when "review the plan first" is on).
   For now a plan review of a voice run is not sent to the phone (the push notification
   and the app handle it). Sending it would be a wire change.
2. **Approvals that expire** (the run ended while one was pending) publish nothing, so a
   phone stops asking only on the run's terminal `run.status`. Fine unless you want an
   explicit `approval.decided` with a third value, which would be a wire change.
3. **Android SDK**: see the summary given to the user at the end of wave 0.

## Decisions during the waves

(none yet)

## Baseline

- `main` at `737f0e5`, 2026-11-22: backend `ruff`, `ruff format --check`, `mypy`,
  `lint-imports` clean and 1224 tests passed; frontend typecheck, lint, import rules clean
  and 557 tests passed (114 files).
- `integrate/devices` with the wave-0 stubs: the same backend checks, 1224 passed, run
  through `../anemo-progress/backend.sh base check` (its own database `anemo_test_base`).
- .NET: a WinForms probe published as a self-contained single file for `win-x64` and
  `win-arm64` with `EnableWindowsTargeting=true`.
- Not run in wave 0: `make e2e` (the Playwright stack); X1 and wave 3 run it.
