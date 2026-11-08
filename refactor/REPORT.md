# Refactor report

The final comparison with `BASELINE.md`, measured on 2026-11-08 the same way as the baseline,
on all refactor branches merged together (`refactor/conventions` with `fix/workspace-symlink-race`,
`fix/trash-restore-name`, `fix/markdown-remote-images`, `refactor/safety-net`,
`refactor/format-size` and `chore/remove-dump-rdb`), against a throwaway Postgres and Valkey.

## What was done

| PR | What | Kind |
|---|---|---|
| refactor/notes | audit, plan, decisions, bugs, baseline, progress | docs |
| fix/workspace-symlink-race | file tools no longer follow a symlink swapped in after the path check (sec-1) | security fix |
| fix/markdown-remote-images | images from other sites in answers and documents wait for a click (sec-4) | security fix |
| fix/trash-restore-name | restoring from the trash only moves the item kept in its slot (sec-5) | security fix |
| refactor/safety-net | OpenAPI contract test, coverage tooling, music-queue tests | tests and tooling |
| refactor/run-lifecycle | shared run lifecycle for chat and agent runs, then the stuck-run fix (core-B1) | refactor + fix |
| refactor/agent-modules | prompt, run snapshot and run end moved out of `agent.py` | refactor (moves) |
| refactor/agent-loop | the tool loop split by call state, `execute_agent_run` by phase | refactor |
| refactor/format-size | one `formatSize` | refactor |
| chore/remove-dump-rdb | `dump.rdb` removed from the tree, `*.rdb` ignored | repo hygiene |
| refactor/conventions | `CLAUDE.md`, `docs/architecture.md`, import boundaries, this report | docs and tooling |

## Before and after

| | Before | After |
|---|---|---|
| ruff, ruff format, mypy, `alembic check` | pass | pass |
| Import boundaries (backend `lint-imports`, frontend `lint:imports`, no-cycles test) | none | 6 contracts kept; 0 new frontend violations (8 known, recorded) |
| Backend tests | 783 | **833** (+50) |
| Backend line coverage | 83 % (16,350 statements) | 83 % (16,627 statements, 2,899 missed) |
| Backend test time | 3 min 49 s | 3 min 46 s (with coverage) |
| Frontend tests | 197 (43 files) | **210** (46 files) |
| Frontend line coverage | 65.4 % of the lines tests load; 230 of 309 files loaded by no test | 65.8 %; 229 of 310 |
| Frontend test time | 14 s | 15 s |
| `vite build` | pass (13 s) | pass |
| E2E (30 specs, local, one worker) | not run (no Docker registry access here) | **74 of 77 pass**, 1 skipped (the browser spec, skipped by default), 2 failed in `motion.spec.ts`; the 3 automation tests that a failure blocks pass on their own. The motion test is flaky on `main` as well (closing animations: 8 of 10 failed on `main`, 5 of 10 here; the cross-fade test failed once in the full run and passed 12 of 12 repeats). BUGS test-1. |
| OpenAPI schema | matches the committed one | matches; now checked by a test |
| Lines of code (same file types) | 84,455 | 86,200 (+1,745: about 1,000 of new tests, 258 in `safe_fs.py`, the rest new module headers and docstrings) |
| Duplicated code (8-line windows) | Python 0.8 %, TypeScript 0.0 % | Python 0.79 %, TypeScript 0.0 % |
| Duplicated code (5-line windows) | Python 2.8 %, TypeScript 0.8 % | Python 2.6 %, TypeScript 0.8 % |
| Module-level import cycles (backend / frontend) | 0 / 2 | 0 / 2 (now recorded as known, new ones fail) |
| `runtime/agent.py` | 1,623 lines; longest functions 197 and 178 | 1,289 lines; longest 93 |
| Longest function in the backend | `stats.compute` 194 | `stats.compute` 194 (not in scope) |
| Startup | API 2.4–2.8 s; worker 0.4 s | the same within noise: API 2.6–3.3 s vs 2.6–2.9 s for `main` measured in alternating runs just before; worker 0.5 s |

### The 20 largest files, after

agent.py moved from first at 1,623 lines to first at 1,289; the rest of the list is unchanged
(the refactor did not touch those files).

## Every item in the inventory is still covered

Of the inventory in `AUDIT.md` §2 (and its appendices):

- **Covered by passing automated tests**: the 212 HTTP routes (each through API tests, and all of
  them through the OpenAPI contract test for their shape), the 57 tools (`test_agent*`,
  `test_*_tools`, `test_file_exchange`, …), the job types (in-process), the settings sections,
  every critical flow in the smoke list (login, streaming chat, tool call and approval,
  documents, tasks, calendar, focus timer, music queue append and replace, memories,
  notifications including Discord and Web Push) in API tests and e2e specs, and the side services
  (execd, hostd and the browser guard in-process; browserd and runnerd in their own CI jobs).
- **Not covered by an automated test** (check these by hand):
  - the worker's own loop (`jobs/runner.py` lanes and lease reaper, `jobs/scheduler.py`,
    `main_worker.py`): tests run jobs in-process; only `JobRunner._execute` is now tested;
  - the real provider adapters against real APIs (OpenAI, Anthropic, OpenRouter, Claude
    subscription): the tests use the fake provider;
  - the shell sandboxes as containers (no network, read-only, limits): execd is tested
    in-process, the containers aren't;
  - the browser e2e spec, which is skipped unless the browser container is started;
  - real push delivery through a push service, and real Discord delivery.

## What you should check by hand

After merging, on your install (with a backup taken first):
1. Chat and agent answers stream, can be stopped and get a title; an agent asks for approval and
   continues after "Allow once"; plan review "always"; pause and resume; an automation runs.
2. Files: copy, move, rename, delete, restore from the trash, empty the trash; an agent reads,
   writes, zips, unzips and attaches files; a folder that is a symlink inside the workspace opens.
3. An answer or document with an image from another site shows "show image from …" and loads it
   on click; images stored in the workspace show at once.
4. Sizes in Files, task attachments and the file finder read as before.
5. The worker restarts cleanly (`docker compose restart worker`) in the middle of a long answer.

## Bugs (`BUGS.md`)

109 items, 4 fixed (sec-1, sec-4, sec-5, core-B1), 105 open and waiting for your decision:

| Severity | Count | Open, most important |
|---|---|---|
| High | 1 | (core-B1 fixed) |
| Medium-High | 2 | (sec-1, sec-4 fixed) |
| Medium | 10 (sec-5 fixed) | sec-6 default permissions let an agent send data out without asking (your decision); invalid time zone stops reminders; parallel document GETs race (500); symlinks out of the workspace break listings; delete/move act on a link's target; Anthropic `max_tokens` 64k for every model; chat keeps the previous chat's model and draft; a failed send loses the message; appearance reverts after a remount |
| Low-Medium | 19 | shell risk misses `python3 -c` and git `-c`; profile `plan_review` without re-auth; login lock-out; SSE after logout; test-search SSRF; run restart counting differs between chat and agent (run-1, run-2); folder access re-check (sec-25); … |
| Low and below | 77 | see the file |

## Not refactored, and why

- `conversations/service.py`, `providers/adapters/claude_code.py`, `policy/shell_risk.py`: big,
  but no function over about 170 lines (left alone, as agreed).
- `stats.compute` (194 lines), `claude_code.plan` (134), `memory.extraction.extract` (100): long
  but self-contained; not in the agreed scope.
- The four `slugify` functions and the per-feature `useRefresh` hooks: different on purpose.
- Mixed conventions that cause no bug (commit placement, PATCH styles, query keys, uuid4/uuid7,
  time-zone validation, hard-coded text sizes): written down for new code in `CLAUDE.md`.
- The frontend's two import cycles and 14 mutually importing feature pairs: recorded as known in
  the dependency-cruiser baseline; untangling them was not part of the plan.
- The `AgentRun` class (895 lines): no method in it is long any more (D13).
- Chat vs agent restart counting (run-1, run-2): kept different, pinned by tests, your decision.

## What needs your action

- **No** env var, migration, Docker or port change in any of these PRs.
- **New dev dependencies** (pre-approved): `pytest-cov`, `import-linter` (backend);
  `@vitest/coverage-v8`, `dependency-cruiser` (frontend). The dev image picks them up on its next
  build (`make dev` / CI build it anyway).
- **CI** now also runs `lint-imports`, `npm run lint:imports`, and mounts
  `frontend/src/api/openapi.json` into the backend test container for the contract test.
- **Merge order**: `refactor/notes` first. Then the others in any order, except
  run-lifecycle → agent-modules → agent-loop → conventions, which build on each other. Each PR
  appends to `refactor/PROGRESS.md`, and #22/#24 both touch `workspace/files.py` (restore and
  trash list), #25 and the conventions PR both touch CI, the Makefile and the dependency files:
  I rebase whichever comes second, with the combined resolution already tested here.
- **Decisions waiting for you**: sec-6 (default permissions), the dead-code candidates
  (`AUDIT.md` §4), which of the 105 open bugs to fix, the `katex` advisory (dep-1), whether to
  add a Content-Security-Policy (sec-4 follow-up), and the flaky e2e specs (test-1, test-2).
