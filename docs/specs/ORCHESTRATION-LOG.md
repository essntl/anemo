# Orchestration log: Anemo fundamentals

The orchestrator prompt is `00-orchestrator.md`, and the contracts are in `CONTRACTS.md`.
Whoever resumes this work continues from this log.

## Status

| Wave | Package | Branch | Worktree | Status |
|---|---|---|---|---|
| 0 | contracts, stubs, test environment | `integrate/fundamentals` | `.claude/worktrees/orchestrator-spec-d10889` (orchestrator) | done |
| 1 | A1 Sources and provenance | `feat/a1` | `../anemo-a1` | **merged** into integrate/fundamentals (ac85f41); after the merge: backend `all` and the frontend checks (449 tests) green |
| 1 | A2 Documents: properties, search, views, paths | `feat/a2` | `../anemo-a2` | **merged** (55a50f4; 0050 re-chained onto 0045); after the merge: backend `all` and the frontend checks (497 tests) green |
| 1 | T Response timer | `feat/t` | `../anemo-t` | **merged** (230371b; 0040 re-chained onto 0036); after the merge: backend `all` and the frontend checks (474 tests) green |
| 1 | B1 Automations core | `feat/b1` | `../anemo-b1` | **merged** (956a65f; 0045 re-chained onto 0040); after the merge: backend `all` and the frontend checks (482 tests) green |
| 2 | A3 Tasks and events join in | `feat/a3` | `../anemo-a3` | built (3 commits, suite green); in review |
| 2 | B2 Automations with sources | `feat/b2` | `../anemo-b2` | reviewed; builder fixing the review findings |

- **Merge order:** A1, T, B1, A2; then A3, B2.
- **Progress notes:** `C:\Users\user\Documents\Projects\anemo-progress\<id>.md` (outside the repo).

## Wave 0

### What was done

- **Base.** `integrate/fundamentals` was created from `origin/main` (e80e0de). Local
  `main` was behind origin (ad3cca9) and was left alone. The specs are committed in
  `docs/specs/`.
- **Code mapped.** The findings are folded into `CONTRACTS.md`. The ones that matter
  across packages:
  - **Documents.** The file is the truth, and the `documents` row is derived. Every
    save goes through `documents.service._apply` (revision plus a `document.index` job
    30 s later). Changes made outside Anemo are picked up lazily by `reconcile()`, with
    no scan at startup. The front matter is parsed only for `title`.
  - **Search.** `knowledge/index.py` is hybrid (an `english` tsvector plus pgvector `<=>`,
    fused with RRF). There is no vector index (sequential scan), and filters are applied
    after ranking.
  - **Links.** There is no link index: backlinks are found by scanning document text and
    task descriptions. Events have no URL (they link to `/calendar?date=`).
  - **Tasks and events.** They have `created_by` (user|agent) and `run_id`, but no
    "last changed by". They are hard-deleted into `trashed_items` (a payload snapshot).
    Events have no tags.
  - **Runs.** They have `started_at`/`ended_at`; `tool_calls` have `started_at`/`ended_at`
    (not always set on cancel). `totals.active_s` excludes waiting. Nothing records the
    time to first text or the time spent waiting.
  - **Automations.** They already have `notify` (always|on_failure|never), a JSON `state`
    with the `get_automation_state`/`set_automation_state` tools, `on_ask`, overlap
    "skipped" in `fire_due`, and `max_retries`. Each run is a conversation with
    `automation_id`.
  - **Policy.** It is pure (`policy/engine.py`). The overrides are per profile only; the
    run's policy is snapshotted in `agent_snapshot.py`.
- **Stubs committed:**
  - `core/actor.py`: the actor context, default user.
  - `core/refs.py`: object references.
  - `runs.actor_for(run)`.
  - `ToolContext.actor`, set around every `tool.run()` in `runtime/agent.py`.
  - `eventLink` and `chatLink` in `lib/appLinks.ts`.
  - `TEST_REDIS_URL` in `tests/conftest.py`, so each package gets its own Valkey
    database.
  - Unit tests: `tests/unit/test_actor_refs.py` and `appLinks.test.ts`.

### Checks run locally (Windows)

- ruff, ruff format, mypy (`--platform linux`) and lint-imports pass.
- The new unit tests and the import-cycle test pass. The cycle test needs `PYTHONUTF8=1`
  on Windows; that is a local quirk, not a code problem.
- The frontend test for appLinks passes.

### Test environment

The user chose WSL Ubuntu and installed `Ubuntu-24.04`. The orchestrator set it up with
`anemo-progress/bin/setup-wsl.sh`: Postgres 17.12 with pgvector 0.8.7, Redis 7.0, uv and
Python 3.13, the user `anemo`, and the role `anemo_test` (CREATEDB, not a superuser).
The runner is `anemo-progress/bin/anemo-test.sh <id> all|check|pytest|gen-api`; see
`TESTING.md`. Baseline on the integration branch: `all` is green, 1046 passed, 0 skipped.

### Open (needs the user)

1. ~~A backup of the live database~~: the user confirmed it is done (2026-11-20), and
   wave 1 started.

### Wave 1 briefings

They are prepared in `anemo-progress/briefings/` (`common.md` plus per-package
fill-ins in `packages.md`).

## Decisions

| When | Decision | Why |
|---|---|---|
| W0 | The actor is a contextvar set by the worker around tool calls; services read `current_actor()` | No signature changes across services that four packages touch at once; the model can't influence it |
| W0 | Events get `/calendar?event=<id>`; chats are `/c/<id>` | Same style as `/tasks?task=<id>`; chats already have that route |
| W0 | Migration ranges per package; re-chain only the first `down_revision` at merge | Ids never collide during parallel work; re-chaining is mechanical |
| W0 | Each package writes its new texts into its own new locale file | Locale files are globbed; this avoids conflicts in shared dictionaries |
| W0 | The generated API files are regenerated at merge, never hand-merged | Every package changes them |
| W0 | A property key is unique across scopes | A key means one thing; the scope only limits where it may be used |

## Contract changes

| # | When | Change | Why | Affected |
|---|---|---|---|---|
| 1 | W1, A1 review | `external_key_tombstones`: purging a synced item from the trash keeps its key | Spec 01 1.2: "If I deleted a synced event, an automation must not recreate it"; the purge freed the key | A1 only |
| 2 | W1, T review | `waiting_ms` counts `paused` and a waiting sub-agent | The run waits for the user then too, and the UI says so | T (done); B2 reads it |
| 3 | W1, T fixes | `runs.first_text_waiting_ms` / `RunTiming.first_text_waiting_ms` | "Time to first text" must leave earlier waits out | T only |

## Stop (2026-11-20)

The user said "stop". These were stopped: the A2 and B1 builders, the T reviewer, and
the suite run on the integration branch after the A1 merge. The progress notes are in
`anemo-progress/<id>.md`. To resume, restart the A2/B1 builders with their briefing plus
"continue from your progress note and the branch". Re-run the T review. Run
`anemo-test.sh int all` on the integration branch.

**Resumed (2026-11-20, evening).** The "stop" was a Windows lag that needed a restart.
Postgres recovered cleanly. The A2 and B1 builders and the T reviewer were resumed with
their context. The suite on the integration branch after the A1 merge was re-run. To keep
the machine responsive: at most 3 agents at a time, and frontend tests with
`--maxWorkers=2`. A builder runs the backend suite and the frontend tests one after the
other, not at the same time.

## Wave 2 reviews

- **B2** (first review): no blockers. Sent back:
  - a refused create must not count as a change (`ToolResult.changed`)
  - the cancellation path tested on a `create_schedule`-made automation, with an
    optional `profile`
  - `{today}` documented in the tool, and the check arguments shown in the approval
  - an approved old run must not roll back the snapshot
  - resolved check arguments stored
  - server-built notification texts without customer content
  - minors: the catalog key, resume events, the `tick` wording, a11y

  **Ownership grants for these fixes (orchestrator):** `runtime/agent.py`
  (`_note_change`), `tools/base.py` (`ToolResult`), `tools/builtin/schedules.py`, and one
  line each in the `ExternalKeyTaken` branches of `events.py`/`tasks.py`. Those are A3's
  files in wave 2; I resolve the merge.

## Open questions for the user

1. **A server-side guard against customer contact details** in events and notifications
   (spec 02, "Done when"). Today only the run's prompt keeps them out, and the tests
   prove it only with a scripted model. B2 proposes a per-automation opt-in check in the
   runtime. It would refuse write and notify calls whose arguments repeat contact fields
   from untrusted tool results word for word. It misses paraphrases, and it can match by
   mistake when a customer's name is the user's own. This is a design addition, so the
   user decides.
2. **Residual risk, accepted:** the contact rule trusts an MCP server's
   `readOnlyHint`. A server that marks a contacting tool as read-only, and that the
   user has set to "allow", could run without asking. MCP tools ask by default.

## Decisions during wave 1

- **T:** a `paused` run counts as waiting for the user (it waits for the user to resume
  it); accepted. `MessageVersion.timing` is accepted as an extra field. The browser
  learns the server's clock from an `X-Server-Time` header on every `/api` response.
- **Flaky test:** `test_notifications_automations.py::test_failed_runs_are_retried`
  failed once. WSL's clock steps can reorder `created_at`. Watch for it at merge.

## Reviews

- **A1** (first review): no blockers. Sent back:
  - the event source badge in the calendar views
  - the purge tombstone (contract change 1)
  - a race test on the unique key
  - `blocked_by` compared as a set
  - refuse `source_url` without a source
  - make `calendar.service._base` public (separate refactor commit)
  - escape `%` and `_` in `list_events` `query`, and say when results are cut at 200
  - `set_occurrence` without a change records nothing; restore sets `updated_by_ref`
  - a "not found / in the trash" message for `?event=`

  Accepted as is: the external actor is inferred from `author == "external"` (the same
  result as `acting_as(EXTERNAL)`), and the one-line change in `search/service.py`
  required by contract section 2.
- **A1** fixes checked by the orchestrator (3 commits); merged as ac85f41.
- **T** (first review): no blockers. Sent back:
  - the clock offset taken from the receive time, not the midpoint (slow requests
    skewed it)
  - the migration sets `waiting_since` for runs waiting or paused at upgrade time, and
    counts expired approvals
  - the timer kept out of the `role=status` live region
  - "time to first text" without the waiting
  - the popover's accessibility and touch handling
  - the timer next to the agent's "Working…" indicator, as the spec asks
  - one duration per shell row
  - timing tests for `edit_last`/`select_version`, approval expiry and cancelling a
    waiting sub-agent

  Accepted: `paused` counts as waiting (contract change 2).
- **T** fixes (3 commits) checked by the orchestrator and merged as 230371b.
- **B1** fixes (9 commits) merged as 956a65f. Conflict in `runs/models.py`: both
  sides added columns, so both were kept. Checked across packages: B1's `may_start`
  writes `run.status` directly (`queued` ↔ `running`, no waiting state involved) and
  `set_status("running")` still follows, so T's waiting and `started_at` stay right.
- **A2** fixes (10 commits, including the blocker: a loader without aliases, depth and
  size limits, a catch-all; checked by the orchestrator) merged as 55a50f4.
  - Conflicts with A1 in the documents models and router and in the search service.
    Both sides were kept, and the new properties endpoint also returns the actors.
  - Migrations: 0050 → 0051 → 0052.
  - **Wave 1 is done.** The migration chain is 0034 → 0035 → 0036 → 0040 → 0045 →
    0050 → 0051 → 0052.
- **A2** (first review): **1 blocker**, YAML aliases or recursion in front matter crash
  the save path and every document tool. Sent back:
  - re-embedding after a label change
  - the project scope bypass through `project`
  - approvals for ids and old paths
  - the near-duplicate rule (no prefix refusal, digits distinct, agent saves checked)
  - rename/merge also rewriting views and folder defaults, done safely
  - unpinned views reachable
  - unfiltered keyword search as before (english stemming kept in the fusion)
  - the `move_path` offer for instructions and memories
  - a grouped table
  - minors

  Accepted: existing front matter with a value outside a closed list shows a warning and
  indexes nothing (as the spec says); to tell the user.
- **B1** (first review): no blockers. Sent back:
  - the approval summary shows the settings an update clears
  - the old state tools kept as hidden aliases of the state note (decision: one tool
    offered, old prompts keep working)
  - the failure streak reset by a successful check
  - MCP contact rule without the server's `openWorldHint`
  - browser click/type reach people
  - untrusted marking of MCP results, the state note and approval summaries
  - a sub-agent waiting for approval doesn't block
  - `change_check_snapshot` within the retention
  - the dialog doesn't overwrite the state note
  - the deep link finds older runs
  - minors: a 1-minute interval with a change check, no state tool in checks,
    `may_start` lock/attempt/backoff, card status, the run-log query in the service,
    the limit message, a migration test

  Accepted and to report to the user:
  - Waiting approvals no longer block firings, for existing automations too. Existing
    `pause` automations whose actions vary per run may get a new approval each firing.
  - The contact rule (always ask) applies to existing automations too.
  - The state conversion to a text note is lossy for multi-line values, and the
    downgrade gives back `{"note": …}`.
