# Orchestration log: round 4 (event triggers, chat recall, activity log, bulk changes, code wait, device files, desktop auto-update)

Whoever resumes this work continues from here. Inputs: the round's brief (2026-11-25),
`CONTRACTS-round4.md`, `CLAUDE.md`, the docs named there. Rules that hold throughout:
every branch from `docs/round4-contracts` (itself from `origin/main` `f87a49b`); one
worktree, branch and pull request per workstream; nothing merged into or pushed to
`main` by the agents; `integrate/round4` holds all of them merged, for testing together.

## Where things are

- Checkout: `C:\dev\anemo`. Worktrees: `C:\dev\anemo\.worktrees\<id>-<name>` (git-ignored).
- Local toolchain: `C:\dev\anemo\.local-env\` (see its `README.md`); test names per
  workstream in CONTRACTS-round4 §11.
- Sub-agents run in the foreground, several Agent calls in one message (a headless run
  kills background agents ~10 minutes after the orchestrator's turn ends: round 3's
  lesson), at most 4 at a time.

## Plan

| Wave | Workstreams | Why this order |
| --- | --- | --- |
| 0 | orchestrator: code map, contracts, stub `app/core/activity.py`, roadmap table | — |
| 1 | T event triggers, R chat recall, A activity log, B bulk changes | the brief's priorities 1–4; B works against the activity-group stub |
| 2 | W code wait, F device files, M MCP triggers | M needs T's tables (branches from T); W and F are independent |
| 3 | U desktop auto-update | lowest priority; changes `desktop/` and its version after F |

## Status

| Id | Workstream | Branch | PR | Status |
| --- | --- | --- | --- | --- |
| – | Contracts, log, roadmap table | `docs/round4-contracts` | | wave 0 |
| T | Event triggers | `feat/event-triggers` | | not started |
| R | Chat recall | `feat/chat-recall` | | not started |
| A | Activity log with undo | `feat/activity-log` | | not started |
| B | Bulk task and event changes | `feat/bulk-changes` | | not started |
| W | Waiting on a code job | `feat/code-wait` | | not started |
| F | Files between devices and the workspace | `feat/device-files` | | not started |
| M | MCP triggers | `feat/mcp-triggers` | | not started |
| U | Desktop auto-update | `feat/desktop-auto-update` | | not started |

## Wave 0 (orchestrator)

Code map findings that shaped the contracts:

1. **Only the clock starts automations** (`features/automations/service.py` `fire_due`,
   every 30 s from `jobs/scheduler.py`), plus the change check (`change_check.py`) and
   Run now. `start_run(trigger=…)` already takes a trigger name and stores it in
   `runs.options["automation"]`; spec 02's rails (allowlist, notify modes, limits, state
   note, contact tools, failure streak, no overlap via `may_start`) all hang off the
   automation row, so an event trigger that starts a run through `start_run` gets them.
2. **There is no durable event bus.** `events/bus.py` is Valkey streams for live UI
   (`events:global` notices such as `tasks.changed` without details, `code:{job}`); they
   can be wiped. Triggers need events that survive a restart and commit with the change,
   so an outbox table (`trigger_events`) written in the change's transaction, drained by a
   job.
3. **Task, event and document writes are spread** over several services and paths
   (tools, API, scripts, plugins, sync, properties, links, trash). An ORM `after_flush`
   listener catches all of them without editing those services, which the activity log
   edits this round; so the two workstreams don't collide in the same functions.
4. **Code job state transitions** happen server-side in `features/code_sessions/ingest.py`
   (`_end`, `_client_state`, `_result_state`); `CodeJob.state` is a row, so the same
   listener sees them.
5. **No file watcher** exists: "a file arriving" can only mean through Anemo's own file
   operations (`workspace/files.py`); files a shell or sync writes are picked up only
   where Anemo already reconciles them. Recorded as a limit in the T spec.
6. **The MCP client is one connection per call** (`mcp/client.py`), so notifications need
   a long-lived session listener: split out as workstream M.
7. **No activity table**; the pieces are the audit log, provenance (`created_by_ref` /
   `updated_by_ref`), `runs.changes`, file revert and the trash (roadmap *Activity log
   with undo*). A batch needs a group id shared by every entry written inside it: the stub
   `app/core/activity.py` (`activity_group`, `current_group`), so B can work in parallel.
8. Latest migration `0080_plugin_assets`; numbers 0081–0085 reserved (CONTRACTS §10).
9. Desktop version is 1.6.1 (`desktop/Directory.Build.props`); CI's "App versions" check
   needs a bump for any change under `desktop/`. F takes 1.7.0, U the next one after it.
10. Releases publish `SHA256SUMS-desktop.txt` / `SHA256SUMS-desktop-macos.txt`; the
    Windows exe is unsigned, the macOS build is ad hoc signed unless the Developer ID
    secrets are set.

## What happened

(Filled in as the round goes.)

## Contract changes and accepted deviations

(None yet.)

## Open for Artem

(Filled in at the end.)
