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
| – | Contracts, log, roadmap table | `docs/round4-contracts` | #95 | merged via #104 |
| T | Event triggers | `feat/event-triggers` | #99 | merged via #104 |
| R | Chat recall | `feat/chat-recall` | #97 | merged via #104 |
| A | Activity log with undo | `feat/activity-log` | #96 | merged via #104 |
| B | Bulk task and event changes | `feat/bulk-changes` | #98 | merged via #104 |
| W | Waiting on a code job | `feat/code-wait` | #100 | merged via #104 |
| F | Files between devices and the workspace | `feat/device-files` | #101 | merged via #104 |
| M | MCP triggers | `feat/mcp-triggers` | #102 | merged via #104 |
| U | Desktop auto-update | `feat/desktop-auto-update` | #103 | merged via #104 |

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

- **Background launch again.** The first four builders started in the background (the
  Agent tool's default); they were stopped within seconds and relaunched with
  `run_in_background: false`. Pass it explicitly every time.
- **Usage limit mid-wave.** T, A and B were cut off by the 5-hour limit while finishing
  docs. A and B had already pushed draft PRs with green CI; T had everything committed
  but unpushed. A fresh agent finished T from its commits and progress file (resuming
  with SendMessage would have run in the background, which a headless run kills).
- **Wave 2** (W, F, M, plus the T finisher) and **wave 3** (U, stacked on F) ran four at
  a time. Then three fresh reviewers covered T+M, A+B, R+W+F, and one covered U.
- **Review fixes.** The fix agents for T+M, A+B and R+F were interrupted when the
  session ended. What landed: T's fixes 1–5 and the note-asks change (scripts can't use
  trigger tools, savepoint per trigger, serialised dispatch with the automation locked,
  wake-me risk in the user's time zone), all of B's fixes, and F's two security fixes
  (PowerShell profile folders refused, `must_not_exist` on device_file_get; committed by
  the orchestrator after its tests passed). Not done: see *Open for Artem*.
- **Merge.** At Artem's request ("merge everything to main"), everything went in as one
  PR, #104 (`integrate/round4`). Conflicts in `fake.py`, `presets.py`, `registry.py`,
  `security.md` and `roadmap.md` were kept on both sides. Migrations were re-chained to
  0081 → 0082 → 0083 (the repo's revision ids are bare numbers, not the file names
  §10 used).

## Contract changes and accepted deviations

- Revision ids are `"0081"` and so on, not `0081_event_triggers` (CONTRACTS §10).
- T: a trigger is its own row; webhooks belong only to automations; automations with
  only triggers use the `manual` schedule; events no trigger listens for aren't stored.
  T also edited `memory/extraction.py`, `providers/base.py` (the event block),
  `conversations/service.py` (`send_event_turn`), and added more than one hunk to
  `files.py` and `runs/service.py`.
- R: one change in `runtime/agent.py` (`unattended=` for `registry.allowed`), so that an
  automation without a tool list doesn't get the recall tools.
- A: file activity is recorded in `files/router.py`, `runs/agent_router.py` and a
  `before_flush` listener for `FileChange`, not in `workspace/files.py` / `revert.py`.
  Uploads, new folders and text saves in Files aren't logged.
- F: the macOS client is C# (shared Core), not Swift; the device file tools are offered
  with the computer tools rather than only when a files-capable computer is online.
- M: the edits to T's catalogue/matching files; URIs match exactly, not by prefix.

## Open for Artem

Review findings still open (the rest were fixed in #105, #106 and #107):
- R: semantic results are filtered by scope after the top-N; keyword hits can be labelled
  "by meaning".
- Hardware: desktop MANUAL-TESTS 71–88 and the Mac checklist N–O; webhooks through the
  tunnel; a real MCP host with a notifying stdio server.
- To decide: the embedding of ordinary chats once an embedding model is set (on by
  default); the global trigger ceiling's default; the device folder rule; setting
  `DESKTOP_UPDATE_SIGNING_KEY` / `DESKTOP_UPDATE_PUBLIC_KEY`.
