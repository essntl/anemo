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
| 0 | contracts, stubs, plan | `integrate/devices` | orchestrator (Claude Fable 5.2) | done; the user gave the OK for wave 1 |
| 1 | D1 devices core | `feat/d1` | Opus 5.5 | reviewed (Opus 5.5): no blockers, 5 should-fix + notes; sent back to its builder |
| 1 | D2 computer tools | `feat/d2` | Opus 5.5 | built (278351f, d867da3; 1263 backend tests); in review (Opus 5.5); merges after D1 and V1 |
| 1 | V1 voice backend | `feat/v1` | Opus 5.5 | reviewed (Opus 5.5): 1 blocker (stale approval in the reply path) + fixes; sent back to its builder |
| 1 | W1 Windows client | `feat/w1` | Opus 5.5 | built (b4dfd60; 186 tests; both publishes work; Linux CI job not run here); review pending |
| 1 | A1 Android app | `feat/a1` | Opus 5.5 | building since 2026-11-22 (took D2's slot) |
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
| Android SDK | installed by the orchestrator with the user's OK (licences accepted) at `C:/Users/user/AppData/Local/Android/Sdk`: command-line tools, `platform-tools`, `platforms;android-35`, `build-tools;35.0.0`. No `ANDROID_HOME` is set: `android/local.properties` (not committed) names it |
| Gradle 8.14.3 | at `C:/Users/user/AppData/Local/Gradle/gradle-8.14.3` (only to create the wrapper). A probe app (AGP 8.7.3, Kotlin 2.0.21, compileSdk 35) passed `./gradlew test assembleDebug` |
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

None open (both wave-0 questions are answered under "Decisions during the waves").

## Decisions during the waves

- **Plan reviews by voice (the user's decision, a wire change made before wave 1).**
  `approval.requested` gets kind `"plan"` with `steps`; `/voice/replies` decides it like
  an action (yes accepts the plan as proposed). Changed: `device-contracts.md` §2 and §4,
  `05-voice-android.md`, `CONTRACTS-devices.md` §3. Touches D1 (forwarding), V1 (replies)
  and A1 (reading it out); all three start from the changed files.
- **Shared-screen read interface (orchestrator, no wire change).** D2 could not read
  D1's shared screen: the contract named no function. Added `shared_screen.current()` to
  `CONTRACTS-devices.md` §1. D1 was already running: check its module against this when
  it reports, and wire `computer.current_shared_screen` at D2's merge.
- **D2 notes to check in review:** clicks/typing/keys set `contacts_people` (automations
  ask), beyond the spec's wording; PowerShell rules added on top of `shell_risk`.
- **D1 review, decided (orchestrator).** Wire addition, compatible with both clients: a
  trust change closes the device's connection with 1012 so it reconnects and reads the
  new trust (`device-contracts.md` §2; W1 already reconnects on any non-final code: verify
  in W1's review). Sent back to D1: control characters in names and browser-only rename,
  no publish when the lock leaves < 5 s, oversize results answered, subscribe before
  welcome, atomic online key, smaller notes. `devices:lock:<id>` added to CONTRACTS §1.
- **V1 review, decided (orchestrator; wire clarifications, no design change):**
  `device-contracts.md` §4 now lists the three 422 codes, 200 `{say}` for nothing heard and
  the general error shape; `device_name` and `TimelineOut.origin` accepted and written into
  `CONTRACTS-devices.md`. Sent back to V1: `populate_existing` in `decide_approval` and
  `run_not_waiting` → `already_decided`; the Voice chat reuses the oldest idle chat; a
  rollback in `say_answer`; tests. Check A1 against the 422 codes and `say`.
- **V1 points as first reported (superseded by the entry above):** 422 uses dictation's three codes
  (`empty_audio`, `audio_too_large`, `unsupported_audio`) where the wire contract names
  one; an empty transcript answers 200 `{say}`; `runs.options["device_name"]` is an extra
  key. A1 was briefed before these were known: check its handling of 422 and `say`.
- **W1 points:** `Windows.Graphics.Capture` not used (GDI only; the spec allows the
  fallback); a trust change reaches a connected client only on reconnect (W1 suggests D1
  closes the connection on a trust change; the server-side check holds meanwhile): decide
  after D1's review. NPM body size for the shared-screen PUT goes into the deploy notes.
- **Expired approvals (the user's decision):** no extra event; the phone stops asking on
  the run's terminal `run.status`.

## Baseline

- `main` at `737f0e5`, 2026-11-22: backend `ruff`, `ruff format --check`, `mypy`,
  `lint-imports` clean and 1224 tests passed; frontend typecheck, lint, import rules clean
  and 557 tests passed (114 files).
- `integrate/devices` with the wave-0 stubs: the same backend checks, 1224 passed, run
  through `../anemo-progress/backend.sh base check` (its own database `anemo_test_base`).
- .NET: a WinForms probe published as a self-contained single file for `win-x64` and
  `win-arm64` with `EnableWindowsTargeting=true`.
- Not run in wave 0: `make e2e` (the Playwright stack); X1 and wave 3 run it.
