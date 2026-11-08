# Baseline (before any refactor)

Measured on `main` at `7c4e988` on 2026-11-08, in a cloud container (Linux, Python 3.13, Node 22),
against a throwaway Postgres (`pgvector/pgvector:pg17`) and Valkey 8 started for the purpose. No
real data was involved.

How it was run, so the final comparison is like for like:

- Backend checks as in CI, with `ENV=test`: `ruff check .`, `ruff format --check .`, `mypy app`,
  `pytest -q -p no:logging`, `alembic check`.
- The tests that load the side services in-process need their sources at `/opt/execd-src`,
  `/opt/hostd-src` and `/opt/browserd-src` (the dev compose file mounts them). They were linked
  there, so **none of the 783 tests was skipped**. Without them, 20 tests skip.
- Backend coverage: `uv run --with pytest-cov pytest --cov=app` (no lockfile change).
- Frontend: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`.
- Frontend coverage: `npm run coverage` (`@vitest/coverage-v8`, added in the safety-net PR), run at
  that PR's first commit, which changes no source or test file.

## Results

| Check | Result | Time (wall) |
|---|---|---|
| `ruff check` | pass | 0.1 s |
| `ruff format --check` | pass (339 files) | 0.1 s |
| `mypy app` | pass (238 source files) | 21 s |
| `pytest` | **783 passed**, 0 skipped | 3 min 49 s (3 min 53 s incl. start-up) |
| `alembic check` | no pending changes | — |
| Backend line coverage | **83 %** (16,350 statements, 2,812 missed) | — |
| `tsc -b` | pass | 13 s |
| `oxlint src` | pass | 0.3 s |
| `vitest run` | **197 passed** (43 files) | 14 s |
| `vite build` | pass; warns that 4 chunks are over 500 kB | 13 s |
| Frontend line coverage | **65.4 %** of the lines in the 79 files that tests load (1,479 of 2,262); **230 of 309** source files are loaded by no test | 15 s |
| E2E (`e2e/run-isolated.sh`, 30 specs) | not run in this container (its Docker builds can't reach the Debian and GitHub container registries); runs in CI on every PR | — |
| OpenAPI export vs `frontend/src/api/openapi.json` | identical (165 paths) | — |

Slowest tests: `test_a_long_referenced_chat_is_summarised_once_and_the_summary_reused` 4.7 s,
`test_execd_stop_kills_the_process_group` 4.0 s, `test_no_api_response_or_run_record_contains_a_saved_secret` 2.8 s.

Backend files below 60 % coverage: `jobs/runner.py`, `jobs/scheduler.py`, `main_worker.py`,
`cli.py`, `claude_code_check.py` (0 %, the real worker loop never runs in tests),
`providers/adapters/openai_chat.py` 24 %, `claude_runner_client.py` 40 %,
`features/conversations/service.py` 47 %, `features/mcp/router.py` 49 %,
`features/settings/service.py` 54 %, `features/providers/service.py` 59 %,
`providers/adapters/anthropic.py` 59 %, `features/conversations/router.py` 60 %.

## Start-up

| Process | Time |
|---|---|
| API (`uvicorn app.main_api:app`) until `/api/health` answers | 2.4–2.8 s (3 runs) |
| Worker (`python -m app.main_worker`) until it logs "worker starting" | 0.4 s |

## Size

Lines of code in tracked `.py/.ts/.tsx/.css/.sh/.js` files, without the generated
`frontend/src/api/schema.d.ts` (14,264 lines) and lockfiles: **84,455**.

| Module | Files | Lines |
|---|---|---|
| backend/app/features | 138 | 16,096 |
| backend/app/tools | 22 | 4,288 |
| backend/app/runtime | 12 | 3,107 |
| backend/app/providers | 11 | 2,104 |
| backend/app/policy | 6 | 1,137 |
| backend/app/web | 6 | 531 |
| backend/app/workspace | 5 | 478 |
| backend/app/jobs | 5 | 468 |
| backend/app/core | 8 | 361 |
| backend/app/api | 6 | 284 |
| backend/app/knowledge | 3 | 260 |
| backend/app/mcp | 2 | 243 |
| backend/app/events | 3 | 171 |
| backend/app/db | 3 | 94 |
| backend/app top-level files (clients, cli, main_*) | 8 | 885 |
| backend/tests | 71 | 12,747 |
| backend/migrations | 30 | 2,599 |
| frontend/src/features | 278 | 26,696 |
| frontend/src/components | 46 | 3,026 |
| frontend/src/app | 12 | 824 |
| frontend/src (api, hooks, lib, styles, main, test) | 19 | 1,078 |
| e2e | 32 | 3,445 |
| claude-runner | 10 | 1,704 |
| browser | 5 | 1,089 |
| sandbox | 1 | 259 |
| mcp-host | 1 | 227 |

Largest frontend features: chat 3,000, music 2,869, home 1,879, documents 1,819, tasks 1,594,
agents 1,552, focus 1,363.

### The 20 largest files

| Lines | File |
|---|---|
| 1,623 | backend/app/runtime/agent.py |
| 759 | backend/app/features/conversations/service.py |
| 715 | backend/app/providers/adapters/claude_code.py |
| 686 | frontend/src/features/music/player/controller.ts |
| 679 | backend/app/policy/shell_risk.py |
| 575 | backend/tests/api/test_notifications_automations.py |
| 533 | claude-runner/runnerd/sessions.py |
| 532 | backend/app/tools/builtin/file_exchange.py |
| 518 | backend/app/tools/builtin/workspace.py |
| 506 | backend/app/tools/builtin/tasks.py |
| 504 | backend/tests/api/test_projects_chats.py |
| 492 | browser/browserd/app.py |
| 480 | backend/app/features/notifications/service.py |
| 478 | backend/app/features/automations/service.py |
| 463 | backend/tests/api/test_tasks_calendar.py |
| 459 | backend/app/features/tasks/service.py |
| 451 | backend/app/features/runs/router.py |
| 442 | backend/tests/api/test_push.py |
| 437 | frontend/src/styles/app.css |
| 429 | backend/tests/api/test_mcp.py |

Longest functions: `AgentRun` class 826 lines, `AgentRun._process_tools` 197,
`execute_agent_run` 178, `stats.compute` 194, `execute_chat_run` 132, `memory.extraction.extract` 100.

## Duplication and imports

- Duplicated code (normalised windows of 8 lines that occur more than once, without blank,
  comment and import lines): Python **0.8 %** (190 of 23,735 lines), TypeScript **0.0 %**.
  With 5-line windows: Python 2.8 %, TypeScript 0.8 %. Most of the Python share is between the
  provider adapters (`anthropic.py`, `openai_chat.py`, `claude_code.py`), which talk to different APIs.
- Backend import cycles: none among module-level imports. One cycle exists only through
  function-level imports (`runtime.compaction` → `runtime.history` → `runtime.references`).
  30 imports of app modules sit inside functions, most in `jobs/runner.py` (9) and `jobs/scheduler.py` (6).
- Frontend import cycles (madge): 2 — `app/router → CalendarPage → TaskDialog → focusOnTask → app/router`
  and `RunActivity ↔ SubagentRun`.

### Note on frontend coverage

Vitest's v8 provider reports a source file that no test imports as having no lines, so such files
don't lower the percentage. The number above is therefore "how much of the code that tests reach
is run", and the count of files no test loads is the other half of the picture. The final
comparison uses the same tool and the same two numbers.
