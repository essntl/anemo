# Anemo: notes for coding agents

Anemo is a single-user, self-hosted AI workspace: chat and autonomous agents with tools,
documents, files, tasks, calendar, focus timer, music, memories, automations, MCP, a browser
and shell sandboxes. Read this file before changing anything, and `docs/architecture.md` for
the why. The conventions here are for **new code**; existing code that works is not rewritten
to match them.

## Layout

```
backend/app/
  main_api.py, main_worker.py, cli.py   entry points: API process, worker process, CLI
  core/        config (env vars), db, redis, errors, logging, crypto, ids. Imports no other app module.
  db/          SQLAlchemy base and mixins; models.py imports every model (for Alembic)
  api/         router.py mounts every router; deps.py (Db, sessions); sse.py; security.py
  features/<x>/ one folder per domain: router.py (HTTP), service.py (logic), models.py (tables),
               schemas.py (Pydantic in/out, when not in the router)
  runtime/     runs in the worker: dispatch.py → chat.py (plain chat) or agent.py (tool loop);
               lifecycle.py (shared by both), agent_snapshot.py, agent_prompt.py, agent_finalize.py
  tools/       base.py (Tool), registry.py (the list of built-in tools), builtin/*.py, mcp_tool.py
  policy/      the permission engine: pure, no IO
  providers/   model adapters (OpenAI, Anthropic, OpenAI-compatible, Claude subscription, fake)
  jobs/        the Postgres job queue, the worker's job runner and the 30 s scheduler
  workspace/   path checks (fs_guard), file operations (files)
  web/, knowledge/, mcp/, events/   web fetch/search, embeddings index, MCP client, Valkey streams
backend/tests/ unit/ (no database), api/ (HTTP + worker code against a test database), integration/
backend/migrations/  Alembic
frontend/src/
  app/         router.tsx, AppLayout, Sidebar; shared stores (projectStore, sidebarStore, mobileNav*)
  features/<x>/ pages and components of one area, api.ts (queries and mutations), stores, tests
  components/  ui/ (Button, Dialog, Select, toast, Markdown, …) and diagrams/: shared, no feature code
  lib/, hooks/ shared helpers (format, cn, appLinks, …): no feature code
  api/         client.ts (typed openapi-fetch client); schema.d.ts and openapi.json are generated
e2e/           Playwright specs against a throwaway stack with the fake model provider
sandbox/ mcp-host/ browser/ claude-runner/   the side containers (execd, hostd, browserd, runnerd)
refactor/      audit, plan, decisions, bugs and progress of the 2026 refactor
```

## Commands

- Everything backend runs in the dev container: `make lint`, `make test-backend`, `make migrate`,
  `make revision m="…"`. `make dev` starts the hot-reload stack (http://localhost:5173).
- Frontend: `cd frontend && npm run typecheck && npm run lint && npm run lint:imports && npm test`.
- `make gen-api` after any backend API change (regenerates `openapi.json` and `schema.d.ts`).
- `make e2e` runs every Playwright spec against a throwaway stack. `make coverage` for both sides.
- Never point tests or scripts at a real install: tests make their own `aiw_test` database.

## Recipes

### A tool for the agent
Reference: `backend/app/tools/builtin/notify.py`.
1. In `tools/builtin/<area>.py`, write a Pydantic `Input` model (with `Field` descriptions, they
   reach the model) and a `Tool` subclass: `name`, `description`, `capability`, `Input`,
   `idempotent` (only if a repeat after a crash is harmless), `actions()` and `run()`.
2. `actions()` describes what the call would do as `Action`s (capability, resource, summary,
   risk); the policy engine decides allow/ask/deny from them. Never return an empty list.
   File paths go through `path_action()` (`tools/builtin/workspace.py`).
3. `run()` returns a `ToolResult`; errors the model should see are `ToolResult(is_error=True)`.
   Open your own session: `async with get_sessionmaker()() as db:`.
4. Add an instance to `BUILTIN_TOOLS` in `tools/registry.py`. A new capability also needs a
   category in `policy/presets.py` (label, description, default level).
5. Tests: `tests/api/test_agent.py` shows how to script the fake model (`script`, `call`,
   `agent_turn`) and assert on the timeline.

### An HTTP endpoint
Reference: `backend/app/features/daily_notes/router.py` and `service.py`.
1. In `features/<area>/router.py`: `router = APIRouter(prefix="/<area>", tags=["<area>"])`,
   request and response models (`…In`, `…Out`), `response_model=` on every route.
2. Take the session as `db: Db` (`app.api.deps`). Keep the handler thin: parse, call the
   service, shape the response. The logic goes in `service.py`.
3. Mount the router in `api/router.py` under `protected` (login required). A change that is
   security-sensitive needs the password confirmed again (`require_recent_auth` in `api/deps.py`,
   used by `settings/router.py`).
4. Run `make gen-api` and commit `frontend/src/api/openapi.json` and `schema.d.ts`; the API
   contract test (`tests/unit/test_openapi_snapshot.py`) fails until you do.
5. Tests: an API test in `tests/api/` using the `authed` client fixture.

### A background job
Reference: `document.index` (`features/documents/service.py` enqueues, `jobs/runner.py` handles).
1. Enqueue from a service: `await queue.enqueue(db, "<area>.<verb>", {...ids as strings},
   lane="background", dedupe_key=…)`, then commit.
2. Add the handler to `default_handlers()` in `jobs/runner.py` (import inside the handler, as
   the others do). Handlers must be safe to run again: a failed job is retried (3 attempts).
3. If a job that fails for good leaves something half done, add a give-up hook to
   `default_give_ups()` (see `run.execute`).
4. Something on a timer instead: add it to `jobs/scheduler.py` (every 30 s; keep it quick and
   gate slow work by time, as `updates.check_if_due` does).

### A setting
Reference: `FocusSettings` in `backend/app/features/settings/sections.py`.
1. Add a field with a default to an existing section model, or a new model registered in
   `SECTIONS` (`sensitive=True` if changing it should need the password again). Defaults live
   in the model, so no migration is needed.
2. Read it with `settings_service.get_section(db, Model, "<section>")`.
3. `make gen-api`; in the frontend use `useSettings()` and `useSaveSection('<section>')`
   (`features/settings/api.ts`).

### A page in the app
Reference: `frontend/src/features/stats/`.
1. `features/<area>/<Area>Page.tsx` plus `api.ts` with the queries (`useQuery` with an exported
   query key constant) and mutations (`useMutation`, then update or invalidate those keys).
2. Add the route in `app/router.tsx` with `page(() => import(...), 'AreaPage')` (lazy), the entry
   in `features/search/pages.ts` (command palette) and, if it belongs there, in `app/Sidebar.tsx`.
3. A keyboard shortcut goes into `features/shortcuts/registry.ts`, nowhere else.
4. Tests next to the code (`*.test.ts(x)`, vitest + Testing Library); an e2e spec in `e2e/tests/`
   for a new flow.

## One way to do each thing (new code)

**Backend**
- *DB access*: routers take `db: Db`; services take `db: AsyncSession` as their first argument;
  worker code and tools open `async with get_sessionmaker()() as db:`. No raw SQL unless an ORM
  query can't express it, and then only with bound parameters.
- *Transactions*: the service function that completes a change commits it. A helper that is part
  of a bigger change doesn't commit, and says so in its docstring.
- *Errors*: raise `AppError` or a subclass (`NotFound`, `Conflict`, `Forbidden`, …) from
  `app.core.errors` with a stable `code`; they render as `{"error": {code, message, details}}`.
  Don't raise `HTTPException`.
- *Logging*: `log = logging.getLogger(__name__)`; a short constant message, data in
  `extra={"ctx": {...}}` (JSON logs). Never log secrets or message contents.
- *Config*: deployment values only through `get_settings()` (`core/config.py`, env vars,
  documented in `.env.example`); user preferences are settings sections.
- *Validation*: Pydantic models with `Field` limits on every request body.
- *Responses*: Pydantic `…Out` models via `response_model`; 204 for a delete with nothing to return.
- *IDs and time*: tables use `IdMixin` (UUIDv7) and `TimestampMixin`; times are `datetime.now(UTC)`;
  the user's time zone comes from `settings_service.user_timezone(db)`.
- *Workspace files*: always through `app.workspace.files` (or `fs_guard.resolve` for a path check),
  never `open()` on a path built from user or model input.
- *Outbound HTTP to an address a user or model chose*: through `web/safe_http.py`.

**Frontend**
- *Server state*: TanStack Query hooks in the feature's `api.ts`, using the typed `api` client and
  `unwrap()`; never raw `fetch` for JSON endpoints (uploads may use `fetch` for progress).
- *Client state*: a small zustand store (`<name>Store.ts`) when several components need it,
  `useState` otherwise. Browser storage keys start with `anemo.`; existing keys must not be renamed.
- *Errors and feedback*: `toast(...)` from `components/ui/toast`; `errorMessage(err)` for API errors.
- *Styling*: Tailwind with the semantic tokens from `styles/app.css` (`bg-surface`, `text-muted`,
  `border-border`, `bg-accent`…); no hard-coded colours; `cn()` to combine classes; reuse
  `components/ui` before writing a new control.
- *Shared helpers*: `lib/format.ts` for dates, sizes, durations and costs; don't add another copy.

## Tests

- Every new feature comes with tests; every new or changed endpoint is covered by an API test.
- Bugs get a test that fails without the fix.
- Don't weaken, skip or delete a test to get green; if a test is wrong, say why in the PR.
- The import-boundary checks (`lint-imports`, `npm run lint:imports`) and the no-cycles test must
  pass. Don't add an exception to them to make a change fit; fix the dependency.

## Don't

- Don't put business logic in routers, or HTTP concerns in services.
- Don't import `app.runtime`, `app.jobs.runner` or the worker from the API side, and don't make
  `core/` or `policy/` depend on anything else in the app (enforced).
- Don't import feature code from `components/`, `lib/`, `hooks/` or `api/`, or the router and
  layout from a feature (enforced).
- Don't import a module's `_private` names from another module; make them public or move them.
- Don't let a run end without a terminal status: end it through `agent_finalize.finalize` or the
  chat path's `_finish`.
- Don't read env vars outside `core/config.py`, and don't put secrets in the database unencrypted
  (`features/secrets`).
- Don't load remote content into the app's page from model or agent output: an image from another
  site waits for a click, as in Markdown and the document editor (see `docs/security.md`).
- Don't add a fourth copy of something: `slugify`, `formatSize`, date formatting. Look first.
- Don't change behaviour in a refactor commit, and don't mix a refactor with a fix.
