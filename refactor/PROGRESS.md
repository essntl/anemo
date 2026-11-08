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
| 0 notes | `refactor/notes` | in review |
| S1 symlink race | `fix/workspace-symlink-race` | next |
| S2 remote images in Markdown | `fix/markdown-remote-images` | to do |
| S3 trash restore | `fix/trash-restore-name` | to do |
| 1 safety net | `refactor/safety-net` | to do |
| 2 run lifecycle | `refactor/run-lifecycle` | to do |
| 3 agent modules | `refactor/agent-modules` | to do (after 2) |
| 4 agent loop | `refactor/agent-loop` | to do (after 3) |
| 5 formatSize | `refactor/format-size` | to do |
| 6 dump.rdb | `chore/remove-dump-rdb` | to do |
| 7 conventions | `refactor/conventions` | to do (last) |

## Open questions

- sec-6 (default permissions let an agent send data out without asking): owner to decide.
- Dead-code candidates in AUDIT.md §4: owner to decide whether any is removed.
- Which of the bugs in BUGS.md to fix: owner to decide.

## Log

- 2026-11-08: baseline measured, audit written, plan approved (answers 1a, 2a, 3a, 4a, 6a, 7a).
