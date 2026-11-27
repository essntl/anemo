# Anemo: notes for coding agents

Anemo is a single-user, self-hosted AI workspace: chat and autonomous agents with tools,
documents, files, tasks, calendar, focus, music, memories, automations, MCP, a browser and
shell sandboxes. FastAPI + Postgres + Valkey backend (API and worker processes), React +
TypeScript frontend, side containers, desktop and Android clients.

**Start with [docs/code-map.md](docs/code-map.md)**: where things live, how to run one test,
recipes (a tool, an endpoint, a job, a setting, a page) and the gotchas that cost jobs time.
The other docs are reference, not required reading: `docs/architecture.md` (the design and the
why), `docs/security.md`, `docs/features.md`, `docs/specs/` (past feature rounds), `refactor/`.
Open the section your task needs; read a spec only when the task names it.

The rules below are for **new code**; existing code that works is not rewritten to match them.

## Commands

- Backend runs in the dev container: `make lint`, `make test-backend`, `make fmt`, `make migrate`,
  `make revision m="…"`. `make dev` starts the hot-reload stack (http://localhost:5173).
- Frontend: `cd frontend && npm run typecheck && npm run lint && npm run lint:imports && npm test`.
- `make gen-api` after any backend API change; commit `openapi.json` and `schema.d.ts`.
- `make e2e`: every Playwright spec against a throwaway stack with the fake model.
- Never point tests or scripts at a real install: tests make their own databases.

## One way to do each thing

**Backend**
- *DB access*: routers take `db: Db`; services take `db: AsyncSession` first; worker code and
  tools open `async with get_sessionmaker()() as db:`. No raw SQL unless the ORM can't express
  it, and then only with bound parameters.
- *Transactions*: the service function that completes a change commits it; a helper that is part
  of a bigger change doesn't, and says so in its docstring.
- *Errors*: raise `AppError` or a subclass (`NotFound`, `Conflict`, `Forbidden`, …) from
  `app.core.errors` with a stable `code`. Don't raise `HTTPException`.
- *Logging*: `log = logging.getLogger(__name__)`; a short constant message, data in
  `extra={"ctx": {...}}`. Never log secrets or message contents.
- *Config*: deployment values only through `get_settings()` (`core/config.py`, documented in
  `.env.example`); user preferences are settings sections.
- *Requests and responses*: Pydantic models, `Field` limits on every request body; `…Out` models
  via `response_model`; 204 for a delete with nothing to return.
- *IDs and time*: `IdMixin` (UUIDv7) and `TimestampMixin`; `datetime.now(UTC)`; the user's time
  zone from `settings_service.user_timezone(db)`.
- *Workspace files*: through `app.workspace.files` (or `fs_guard.resolve`), never `open()` on a
  path built from user or model input.
- *Outbound HTTP to an address a user or model chose*: through `web/safe_http.py`.

**Frontend**
- *Server state*: TanStack Query hooks in the feature's `api.ts` with the typed `api` client and
  `unwrap()`; no raw `fetch` for JSON endpoints (uploads may, for progress).
- *Client state*: a small zustand store (`<name>Store.ts`) when several components need it,
  `useState` otherwise. Browser storage keys start with `anemo.`; never rename existing keys.
- *Feedback*: `toast(...)` from `components/ui/toast`; `errorMessage(err)` for API errors.
- *Styling*: Tailwind with the semantic tokens (`bg-surface`, `text-muted`, `border-border`,
  `bg-accent`…), no hard-coded colours, `cn()` to combine; reuse `components/ui` first.
- *Shared helpers*: `lib/format.ts` for dates, sizes, durations and costs.
- *Text the user sees*: English in the code through `t('…')`, `plural(…)`, `rich(…)` from
  `lib/i18n.tsx` (`msg('…')` in module-level constants); dates with `dateLocale()`. Add the
  Ukrainian and Russian text to `src/locales/<language>/<area>.ts`.
- *Pages in the menus*: `PAGE_INFO` (`features/settings/navigation.ts`) and `PageId`
  (backend `settings/sections.py`); its agent tools go in `FEATURE_TOOLS` (`tools/registry.py`).

## Tests

- Every new feature comes with tests; every new or changed endpoint has an API test.
- A bug gets a test that fails without the fix.
- Don't weaken, skip or delete a test to get green; if a test is wrong, say why in the PR.
- The import-boundary checks and the no-cycles test must pass; fix the dependency, don't add
  an exception.

## Don't

- Don't put business logic in routers, or HTTP concerns in services.
- Don't import `app.runtime`, `app.jobs.runner` or the worker from the API side; `core/` and
  `policy/` depend on nothing else in the app (enforced).
- Don't import feature code from `components/`, `lib/`, `hooks/` or `api/`, or the router and
  layout from a feature (enforced).
- Don't import a module's `_private` names from another module; make them public or move them.
- Don't let a run end without a terminal status: end it through `agent_finalize.finalize` or the
  chat path's `_finish`.
- Don't read env vars outside `core/config.py`; secrets go encrypted (`features/secrets`).
- Don't load remote content into the app's page from model or agent output: an image from
  another site waits for a click (`docs/security.md`).
- Don't add another copy of `slugify`, `formatSize` or date formatting. Look first.
- Don't change behaviour in a refactor commit, and don't mix a refactor with a fix.
