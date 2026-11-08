# Progress

Read this file and PLAN.md first at the start of every session. Each PR updates it.

## How to work on this

- Branch off the latest `main`: `git fetch origin main && git checkout -b <branch> origin/main`.
- Backend checks need Postgres (pgvector) and Valkey. Outside the dev container, start throwaway
  ones (`docker run -d -p 127.0.0.1:5432:5432 -e POSTGRES_USER=aiw -e POSTGRES_PASSWORD=aiw -e POSTGRES_DB=aiw pgvector/pgvector:pg17`
  and `docker run -d -p 127.0.0.1:6379:6379 valkey/valkey:8-alpine`), then from `backend/`:
  `ENV=test DATABASE_URL=postgresql+asyncpg://aiw:aiw@localhost:5432/aiw REDIS_URL=redis://localhost:6379/0`
  with `uv run ruff check . && uv run ruff format --check . && uv run mypy app && uv run pytest -q -p no:logging && uv run alembic check`.
  For the tests that load the side services in-process, link `sandbox/execd`, `mcp-host/hostd` and
  `browser/browserd` to `/opt/execd-src`, `/opt/hostd-src` and `/opt/browserd-src`.
- Frontend: `cd frontend && npm ci && npm run typecheck && npm run lint && npm test && npm run build`.
- Never against real data: the tests create their own `aiw_test` database and use Redis database 15.

## Status

| Step | Branch | State |
|---|---|---|
| Phase 0: baseline | — | done (BASELINE.md) |
| Phase 1: audit and plan | — | done, plan approved 2026-11-08 |
| 0 notes | `refactor/notes` | in review ([essntl/anemo#21](https://github.com/essntl/anemo/pull/21)) |
| S1 symlink race | `fix/workspace-symlink-race` | in review (stacked on the notes PR) |
| S2 remote images in Markdown | `fix/markdown-remote-images` | next (covers chat Markdown and the document editor) |
| S3 trash restore | `fix/trash-restore-name` | next |
| 1 safety net | `refactor/safety-net` | in review (stacked on the notes PR) |
| 2 run lifecycle | `refactor/run-lifecycle` | in review (stacked on the notes PR) |
| 3 agent modules | `refactor/agent-modules` | next (stacked on PR 2) |
| 4 agent loop | `refactor/agent-loop` | to do (after 3) |
| 5 formatSize | `refactor/format-size` | to do |
| 6 dump.rdb | `chore/remove-dump-rdb` | to do |
| 7 conventions | `refactor/conventions` | to do (last) |

## Open questions

- sec-6 (default permissions let an agent send data out without asking): owner to decide.
- Dead-code candidates in AUDIT.md §4: owner to decide whether any is removed.
- Which of the bugs in BUGS.md to fix: owner to decide.

## Local end-to-end runs

This container's Docker builds can't reach the Debian or GitHub container registries, so
`e2e/run-isolated.sh` can't build its images here. Instead the app, the worker and two execd
sandboxes run as plain processes (a fresh `aiw_e2e` database, Redis database 2, the built
`frontend/dist`), the fake provider is seeded with `e2e/scripts/seed-fake.mjs`, and Playwright
runs with `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`. CI still runs `run-isolated.sh` on every PR.

## Log

- 2026-11-08: baseline measured, audit written, plan approved (answers 1a, 2a, 3a, 4a, 6a, 7a).
- 2026-11-08: S1 (symlink race) fixed with a reproducing test; 795 backend tests pass.
- 2026-11-08: full e2e locally on S1: 75 passed, 1 skipped (browser), 1 flaky failure that fails on `main` too (BUGS test-1); `automations.spec.ts` passed when run with `--no-deps`.
- 2026-11-08: S2 (remote images) fixed with tests that fail on the old code; frontend 201 tests pass; 22 affected e2e tests pass locally.
- 2026-11-08: S3 (trash restore) fixed with tests that fail on the old code; 795 backend tests pass.
- 2026-11-08: safety net: coverage tooling, the OpenAPI snapshot test (wired into CI and `make test-backend`), music-queue characterization tests; frontend coverage baseline recorded.
- 2026-11-08: run lifecycle: 18 characterization tests, the shared helpers moved to `runtime/lifecycle.py`, then the stuck-run fix (core-B1) as a separate behaviour change; 801 backend tests pass.
- 2026-11-08: e2e locally for the run lifecycle: chat, agents, temporary chats, projects, subtasks 42/42 with `--workers=1` (twice); automations 3/3. With 2 workers two chat tests were flaky (BUGS test-2), so local runs use `--workers=1` from now on.
