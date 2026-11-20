# Orchestration log: Anemo fundamentals

The orchestrator prompt is `00-orchestrator.md`, and the contracts are in `CONTRACTS.md`.
Whoever resumes this work continues from this log.

## Status

| Wave | Package | Branch | Worktree | Status |
|---|---|---|---|---|
| 0 | contracts and stubs | `integrate/fundamentals` | `.claude/worktrees/orchestrator-spec-d10889` (orchestrator) | done, waiting for the user's OK |
| 1 | A1 Sources and provenance | `feat/a1` | `../anemo-a1` | worktree created, not started |
| 1 | A2 Documents: properties, search, views, paths | `feat/a2` | `../anemo-a2` | worktree created, not started |
| 1 | T Response timer | `feat/t` | `../anemo-t` | worktree created, not started |
| 1 | B1 Automations core | `feat/b1` | `../anemo-b1` | worktree created, not started |
| 2 | A3 Tasks and events join in | `feat/a3` | — | after A1, T, B1, A2 are merged |
| 2 | B2 Automations with sources | `feat/b2` | — | after A1, T, B1, A2 are merged |

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

### Open (needs the user)

1. **The test environment.** This machine has no Docker, Postgres, Valkey or WSL distro,
   and the backend can't import on Windows (it uses Linux-only `os.O_*` flags). So the
   API tests, which are most of the suite, can't run here. See the question to the user.
2. **A backup of the live database** before wave 1.

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

None yet.
