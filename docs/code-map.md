# Code map

Where things live, how to test, the recipes, and the gotchas that have cost jobs time.
The rules for new code are in [CLAUDE.md](../CLAUDE.md). Everything else in `docs/` is
reference: open the section you need (`grep -n` for it), don't read whole files up front.

## Where things live

```
backend/app/
  main_api.py, main_worker.py, cli.py   API process, worker process, CLI (python -m app.cli --help)
  core/        config (env vars), db, redis, errors, logging, crypto, ids. Imports no other app module.
  db/          SQLAlchemy base and mixins; models.py imports every model (for Alembic)
  api/         router.py mounts every router; deps.py (Db, sessions, require_recent_auth); sse.py
  features/<x>/ one folder per domain: router.py (HTTP), service.py (logic), models.py (tables),
               schemas.py (Pydantic in/out, when not in the router)
  runtime/     the worker side of a run: dispatch.py → chat.py (plain chat) or agent.py (tool loop);
               lifecycle.py, agent_snapshot.py, agent_prompt.py (system prompt), agent_finalize.py,
               history.py (what earlier turns send), compaction.py
  tools/       base.py (Tool), registry.py (BUILTIN_TOOLS, FEATURE_TOOLS), builtin/*.py, mcp_tool.py
  policy/      the permission engine (allow/ask/deny): pure, no IO; presets.py has the categories
  providers/   model adapters in adapters/ (openai_chat, anthropic, claude_code, fake.py)
  jobs/        queue.py (Postgres job queue), runner.py (handlers), scheduler.py (every 30 s)
  workspace/   fs_guard (path checks), files (all file operations), safe_fs (POSIX-only opens)
  web/ knowledge/ mcp/ events/   web fetch/search (safe_http), embeddings, MCP client, Valkey streams
backend/tests/ unit/ (no database), api/ (HTTP + worker code on a test database), integration/
backend/migrations/versions/   Alembic, numbered 0001_… (see the gotchas below)
frontend/src/
  app/         router.tsx, AppLayout, Sidebar; shared stores (projectStore, sidebarStore, mobileNav*)
  features/<x>/ pages and components of one area, api.ts (queries/mutations), stores, *.test.tsx
  components/  ui/ (Button, Dialog, Select, toast, Markdown, …), diagrams/: shared, no feature code
  lib/ hooks/  shared helpers (format.ts, cn, i18n.tsx, appLinks): no feature code
  api/         client.ts (typed openapi-fetch); schema.d.ts and openapi.json are generated
  locales/     uk/ and ru/ translations, one file per area (README.md: style and glossary)
e2e/           Playwright specs (tests/*.spec.ts, helpers.ts) against a throwaway stack, fake model
extension/     browser extension (its own npm project; uses the generated API types too)
sandbox/ mcp-host/ browser/ claude-runner/   side containers: execd, hostd, browserd, runnerd
desktop/ (.NET, Windows + macOS) android/ (Kotlin) bridge/ (cc.mjs)   the device apps
docs/          architecture.md (the design and why, by section letter), security.md, features.md,
               specs/ (one spec per past feature round), claude-code.md, device-contracts.md
refactor/      history of the 2026 refactor (audit, decisions, bugs); not needed for new work
```

## How to test

| what | command | notes |
| --- | --- | --- |
| backend lint + types | `make lint` | ruff, mypy, lint-imports in the dev container |
| backend tests | `make test-backend` (`n=4`, `n=0`) | one test file: `docker compose -f docker-compose.yml -f docker-compose.dev.yml run --rm -e ENV=test app pytest -q tests/api/test_x.py` |
| frontend | `cd frontend && npm run typecheck && npm run lint && npm run lint:imports && npm test` | one file: `npx vitest run src/features/x/X.test.tsx` |
| extension | `cd extension && npm run typecheck && npm test` | needed after `make gen-api` |
| e2e | `make e2e` (`sh e2e/run-isolated.sh`) | one spec: `sh e2e/run-isolated.sh tests/x.spec.ts` |
| API types | `make gen-api` | after any backend API change; commit both generated files |
| format | `make fmt` (backend only) | format other Python packages from their own folder |

- Tests make their own databases (`aiw_test_gw<N>`, one per xdist worker, and Redis db 15, 14, …);
  never point tests at a real install. Every test starts from `db_clean`; don't depend on order.
- Scripting the fake model. Backend: `script(prompt, *turns)` and `call(name, **args)` in
  `tests/api/test_agent.py` fill `FakeAdapter.scripts`, keyed by the conversation's first user
  text; `agent_turn` runs one turn and returns the run id. e2e: the `agent` model reacts to
  phrases ("ask me", "rename task <id> to <title>", "postpone my tasks: …";
  `providers/adapters/fake.py`), `fakeModels()` in `e2e/tests/helpers.ts` returns the model ids.
- CI (`.github/workflows/ci.yml`) also runs: App versions (a change under `android/` or
  `desktop/` must raise that app's version), Browser service, Claude runner, Browser extension,
  and the Windows/macOS/Android builds.

## Recipes

### A tool for the agent
Reference: `backend/app/tools/builtin/notify.py`.
1. In `tools/builtin/<area>.py`, a Pydantic `Input` model (with `Field` descriptions, they
   reach the model) and a `Tool` subclass: `name`, `description`, `capability`, `Input`,
   `idempotent` (only if a repeat after a crash is harmless), `actions()` and `run()`.
2. `actions()` describes what the call would do as `Action`s (capability, resource, summary,
   risk); the policy engine decides allow/ask/deny from them. Never return an empty list.
   File paths go through `path_action()` (`tools/builtin/workspace.py`).
3. `run()` returns a `ToolResult`; errors the model should see are `ToolResult(is_error=True)`.
   Open your own session: `async with get_sessionmaker()() as db:`.
4. Add an instance to `BUILTIN_TOOLS` in `tools/registry.py` (and to `FEATURE_TOOLS` if it
   belongs to a page). A new capability also needs a category in `policy/presets.py`.
5. Tests: script the fake model as in `tests/api/test_agent.py` and assert on the timeline.

### An HTTP endpoint
Reference: `backend/app/features/daily_notes/router.py` and `service.py`.
1. `router = APIRouter(prefix="/<area>", tags=["<area>"])`, request and response models
   (`…In`, `…Out`), `response_model=` on every route.
2. Take the session as `db: Db` (`app.api.deps`); keep the handler thin, the logic in `service.py`.
3. Mount it in `api/router.py` under `protected`. A security-sensitive change needs the
   password again (`require_recent_auth`, as `settings/router.py` does).
4. `make gen-api`, commit `frontend/src/api/openapi.json` and `schema.d.ts` (the contract test
   `tests/unit/test_openapi_snapshot.py` fails until you do).
5. An API test in `tests/api/` with the `authed` client fixture.

### A background job
Reference: `document.index` (`features/documents/service.py` enqueues, `jobs/runner.py` handles).
1. `await queue.enqueue(db, "<area>.<verb>", {...ids as strings}, lane="background", dedupe_key=…)`, then commit.
2. Add the handler to `default_handlers()` in `jobs/runner.py` (import inside the handler).
   Handlers must be safe to run again: a failed job is retried (3 attempts).
3. Something left half done when it fails for good: a give-up hook in `default_give_ups()`.
4. On a timer instead: `jobs/scheduler.py` (every 30 s; gate slow work by time, as
   `updates.check_if_due` does).

### A setting
Reference: `FocusSettings` in `backend/app/features/settings/sections.py`.
1. A field with a default on a section model, or a new model in `SECTIONS` (`sensitive=True`
   if changing it needs the password). Defaults live in the model: no migration.
2. Read it with `settings_service.get_section(db, Model, "<section>")`.
3. `make gen-api`; in the frontend `useSettings()` and `useSaveSection('<section>')`
   (`features/settings/api.ts`).

### A page in the app
Reference: `frontend/src/features/stats/`.
1. `features/<area>/<Area>Page.tsx` and `api.ts` (`useQuery` with an exported query key
   constant; `useMutation`, then update or invalidate those keys).
2. The route in `app/router.tsx` with `page(() => import(...), 'AreaPage')`, the entry in
   `features/search/pages.ts`, and in `PAGE_INFO` (`features/settings/navigation.ts`) plus
   `PageId` in the backend's `settings/sections.py`.
3. A keyboard shortcut goes into `features/shortcuts/registry.ts`, nowhere else.
4. Tests next to the code (vitest + Testing Library); an e2e spec in `e2e/tests/` for a new flow.

## Gotchas that cost jobs time

- **Migration numbers collide across branches.** Several branches take "the next number" at
  once; CI tests the PR merged with main, and the backend job then dies at
  `service "migrate" didn't complete successfully`. Before pushing a migration, check
  `git ls-tree origin/main backend/migrations/versions/` for the newest one; to fix, merge
  main and renumber (down_revision = main's head).
- **A request field with a default becomes required in TypeScript** (openapi-typescript).
  New optional fields on existing request models are `X | None = None`; after `make gen-api`
  also run `cd extension && npm run typecheck`.
- **Every new UI text needs uk and ru translations** (`src/locales/<lang>/<area>.ts`), or
  `locales.test.ts` fails.
- **Import boundaries are enforced** (`lint-imports`, `npm run lint:imports`, the no-cycles
  test). Fix the dependency; don't add an exception.
- **Changing `android/` or `desktop/` code needs a version bump** (App versions check).
- **Formatting**: `ruff format` uses the config of the folder it runs from; running the
  backend's on `claude-runner/` rewrites 100+ lines. Format only what you touched.
- **xdist and Redis**: each pytest worker takes one Redis database (15 down); more than 15
  workers crash, and pytest can then exit 0 with "no tests ran". Check the "N passed" line.
- **`npm ci` after main moves**: stale `node_modules` breaks `tsc` with odd import errors.
- **Chat history**: later turns of an API chat send only the earlier answers' text, not old tool
  results (`runtime/history.py`); check what is really sent before optimising context.
