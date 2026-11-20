# Contracts for the fundamentals work

Everything here is binding for every package (A1, A2, T, B1 in wave 1; A3, B2 in wave 2).
The specs (`01-…`, `02-…`, `03-…`) decide what is built; this file decides the names,
shapes and boundaries that two packages could otherwise invent differently. If your work
can't be done within it, stop and report what has to change and why. Don't work around it.

Base: branch `integrate/fundamentals` (from `main` at e80e0de). Latest migration on the
base: `0034`.

---

## 1. Actor context (provenance)

**Stub, already on the base:** `backend/app/core/actor.py`.

```python
Actor(kind="user" | "external" | "chat" | "automation", chat_id, automation_id, run_id)
actor.ref        # "user" | "external" | "chat:<conversation id>" | "automation:<automation id>/<run id>"
Actor.parse(ref) # the reverse; ValueError for anything else
current_actor()  # who the running code acts for; USER unless something set otherwise
acting_as(actor) # context manager that sets it
USER, EXTERNAL   # constants
ACTOR_REF_LENGTH = 120
```

- **Where it is set.** Every HTTP request acts as `USER` (the default; nothing to do).
  The worker sets it around every tool call: `runtime/agent.py` wraps `tool.run()` in
  `acting_as(self.ctx.actor)`, and `ToolContext.actor` is filled from
  `runs.actor_for(run)` (`features/runs/service.py`). Already on the base.
- **Which actor a run gets** (`actor_for`): a run with an automation, either
  `run.automation_id` or, for its sub-agents, `run.policy["automation"]["id"]`, is
  `automation:<automation id>/<root run id>`. Otherwise a run with a chat is
  `chat:<conversation id>`. Otherwise `user`.
- **`external`** is passed explicitly by the code that picks up changes made outside
  Anemo (`documents.reconcile`, hash drift in `documents.read`). The browser extension
  and research write-ups (`last_editor = "extension"` today) act for the **user**.
- **The model never passes an actor.** No tool input may carry one.
- **Writes outside tool calls inside the worker** set the actor themselves with
  `acting_as(runs.actor_for(run))`. Example: `automations.on_run_finished` saving a run's
  answer as a document (B1 does this).
- **Services read `current_actor()`** when they write provenance. They don't take an
  actor parameter. Existing parameters (`created_by="agent"`, `author=…`, `run_id=…`)
  stay and keep their meaning.
- **Display.** A1 adds `features/provenance/` with
  `describe(db, refs) -> dict[str, ActorOut]`, a batch lookup:
  `ActorOut {ref, kind, label, url}`. For example
  `{ref: "chat:…", kind: "chat", label: "<chat title>", url: "/c/<id>"}`, or for an
  automation `label: "<automation name>"`, `url: "/automations?automation=<id>&run=<run id>"`
  (B1 makes the Automations page open that automation's run log from these
  parameters; until then the link lands on the page).
  Names are looked up when read and never stored. A deleted chat or automation gives
  `label` "deleted chat" or "deleted automation" and `url: null`.

## 2. Object references

**Stub, already on the base:** `backend/app/core/refs.py` and `frontend/src/lib/appLinks.ts`.

| Type | Canonical reference (= app URL = Markdown link target) | Frontend helper |
|---|---|---|
| document | `/documents/<id>` (an optional `#…` anchor points into it) | `documentLink` |
| task | `/tasks?task=<id>` | `taskLink` |
| event | `/calendar?event=<id>` **(new)** | `eventLink` |
| chat | `/c/<id>` | `chatLink` |

- `ObjectType = "document" | "task" | "event" | "chat"`. This exact spelling is used
  everywhere: tables, `applies_to`, tool parameters, view queries, API schemas.
  `applies_to` uses only the first three.
- `parse_ref(value) -> ObjectRef | None` accepts the URL forms above, also with this
  app's origin in front. Tools that take references (`links`, `links_add`, …) take
  these strings, and tool results give them.
- **A1** makes the frontend open `/calendar?event=<id>`: the calendar goes to the
  event's day and opens the event. It also switches the links to events that it touches
  (search results, tool results) from `?date=` to the canonical reference.
- `features/links/parse.py` keeps its existing regexes for documents, tasks and files.
  A3 builds the link index on `core/refs.py` and may make `parse.py` use it.

## 3. Properties

### 3.1 Definitions (A2 creates; A3 extends to tasks and events)

Table **`property_definitions`** (A2):

| Column | Type | Notes |
|---|---|---|
| id, created_at, updated_at | IdMixin, TimestampMixin | |
| key | String(60), **unique** | slug: `client`, `type`, `status`, `tags` |
| label | String(120) | |
| type | String(20) | `select`, `multi_select`, `text`, `date`, `number`, `checkbox` |
| applies_to | JSONB list | of `"document"`, `"task"`, `"event"`; A2 creates built-ins with all three |
| project_ids | JSONB list or null | null = global; else the projects it is limited to |
| open_vocabulary | Boolean | true only for `tags`: values can be created without approval |
| builtin | Boolean | `type`, `status`, `tags` |
| sort_order | Integer | |

Table **`property_options`** (A2), the allowed values of `select`/`multi_select`:

| Column | Type | Notes |
|---|---|---|
| id, created_at, updated_at | IdMixin, TimestampMixin | |
| definition_id | FK `property_definitions` ON DELETE CASCADE | |
| slug | String(80) | what is stored in files and rows; unique per definition |
| label | String(120) | what the UI shows; changing it touches no files |
| hub_document_id | FK `documents` ON DELETE SET NULL, nullable | the value's hub page |
| sort_order | Integer | |

- **A key is unique across all scopes.** A key means one thing; the scope only limits
  where it may be used.
- **Value encoding, the same in YAML front matter, JSONB and tool I/O:**
  - `select`: slug string
  - `multi_select`: list of slug strings
  - `text`: string
  - `date`: `"YYYY-MM-DD"`
  - `number`: JSON number
  - `checkbox`: boolean
- **Validation and normalisation live in one place**, `features/properties/service.py`
  (A2): `validate(db, object_type, project_id, values, *, create_values=False)`. It
  returns the normalised dict or raises an `AppError` with `code="property_invalid"`,
  whose `details` list the closest existing values. The near-duplicate tag check is in
  the same module. A3 calls these for tasks and events and doesn't copy them.

### 3.2 Where values are stored

- **Documents** (A2). The YAML front matter is the truth. The derived index is on
  `documents`:
  - `properties` JSONB, NOT NULL, default `{}`, with a GIN index
  - `properties_hash` String(64), nullable: the content hash the index was built from
  - `properties_error` Text, nullable: why the front matter couldn't be read (shown as
    a warning)
- **Tasks and events** (A3): `tasks.properties` and `calendar_events.properties`, both
  JSONB, NOT NULL, default `{}`, with GIN indexes. The existing `tasks.tags` (JSONB list)
  is migrated by A3. A3 decides whether `tags` stays a column kept in sync or moves into
  `properties.tags`, and reports it. Either way the `tags` parameter and `TaskOut.tags`
  behave exactly as today.

### 3.3 Property filter (shared shape)

Used by `search_documents`, `list_documents` (A2), `list_tasks`, `list_events` (A3) and
view queries:

```jsonc
{
  "client": "ludmyla-doula",             // =   (for multi_select: has)
  "status": {"in": ["draft", "active"]}, // in
  "tags":   {"has": "legal"},            // has (multi_select contains)
  "type":   {"missing": true}            // missing (no value)
}
```

The SQL lives in `features/properties/filters.py` (A2):
`property_conditions(column, filters) -> list[ColumnElement[bool]]`. It works on any
JSONB `properties` column, so A3 reuses it for tasks and events.

## 4. Views (A2; A3 adds tasks and events)

Table **`saved_views`** (A2):

| Column | Type | Notes |
|---|---|---|
| id, created_at, updated_at | IdMixin, TimestampMixin | |
| name | String(120) | |
| project_id | FK `projects` ON DELETE CASCADE, nullable | shown under that project; null = global |
| pinned | Boolean | |
| sort_order | Integer | |
| query | JSONB | the `ViewQuery` below |
| layout | String(10) | `list`, `table`, `board` |

`ViewQuery` (Pydantic, in `features/views/schemas.py`):

```python
types: list[ObjectType] = ["document"]   # A3 allows "task", "event"
text: str | None
folder: str | None                       # recursive prefix, documents only
project_id: UUID | None
properties: dict[str, Any] = {}          # the filter shape of 3.3
updated_after / updated_before: datetime | None
include_archived: bool = False
sort: list[{key: str, desc: bool}] = []
group_by: str | None                     # a select property key (board)
columns: list[str] = []                  # table layout
```

A2 must not build a documents-only query shape: `types` is there from day one, and the
view endpoint returns rows as `{type, id, title, url, properties, updated_at}`.

## 5. Documents (A2)

- **Path history** table **`document_paths`**: `id`, `document_id` (FK `documents` ON
  DELETE CASCADE), `old_path` String(1000), `moved_at`, `actor_ref`
  String(ACTOR_REF_LENGTH). Index on `old_path`.
- Document tools accept a document id or a reference (`/documents/<id>`) wherever they
  accept a path.
- Search keyword index: A2 adds its own `tsvector` and chooses the text search
  configuration, reported as required by spec 01. Existing `knowledge_chunks` rows and
  memory search keep working.

## 5a. Links (A3, wave 2) (change 4)

Table **`object_links`** (A3), the one link index for all types:

| Column | Type | Notes |
|---|---|---|
| id, created_at | IdMixin, created_at | |
| from_type, from_id | String(10) (`ObjectType`), UUID | the item that links |
| to_type, to_id | String(10) (`ObjectType`), UUID | the item it links to (no FK: dead links must stay visible) |
| origin | String(10) | `inline` (extracted from Markdown on save, rebuilt every save, never edited directly) or `explicit` (set in the UI or through tools on tasks and events) |
| created_by_ref | String(120) | `current_actor().ref` when it was made |

Unique `(from_type, from_id, to_type, to_id, origin)`, and indexes on `(to_type, to_id)`
and `(from_type, from_id)`.

- Documents link only `inline`.
- References are parsed with `core/refs.parse_ref`.
- A target's state is resolved when it is read:
  - live
  - `in_trash` (`trashed_items`)
  - `deleted` (neither, or an `external_key_tombstones` entry)
- Inline links are rebuilt after the document, task or event write. They are added as
  a separate helper call after the write, the same way A2's index is.
- The existing `features/links` backlink functions (`document_backlinks`,
  `task_backlinks`) can then read the index. `task_files` (attachments) stays as it is.

## 6. Sources and provenance columns (A1)

On **`tasks`** and **`calendar_events`** (A1):

| Column | Type |
|---|---|
| created_by_ref | String(120), nullable (null on old rows: unknown) |
| updated_by_ref | String(120), nullable |
| source | String(40), nullable |
| external_key | String(200), nullable |
| source_url | String(1000), nullable |
| synced_at | timestamptz, nullable |
| edited_by_user_at | timestamptz, nullable |

- `external_key` is unique per table (a partial unique index where it isn't null).
- **Trashed items keep their key.** Tasks and events are hard-deleted into
  `trashed_items` (a payload snapshot), so A1 adds `trashed_items.external_key`
  String(200), nullable, with a partial unique index on `(kind, external_key)`. The
  service checks both tables before it creates anything.
- **Deleting for good keeps the key too** (contract change 1). When a trashed task or
  event that has an `external_key` is purged, A1 writes a tombstone row to a new table,
  **`external_key_tombstones`**:
  - `id`, `kind` (`task` | `event`), `external_key` String(200)
  - `title` String(300): the item's title, for the tool message
  - `deleted_at`, `actor_ref` String(120)
  - a unique index on `(kind, external_key)`

  `create_*` with that key creates nothing. Its result says it was "deleted for good by
  the user on <date>; don't recreate it unless the user asks". Detaching from the
  source frees the key and leaves no tombstone. The tombstones are not shown in the
  trash.
- **On `documents`** (A1): `created_by_ref` and `updated_by_ref`, the same types.
- **On `document_revisions`** (A1): `actor_ref` String(120), nullable. The revision
  merge rule (same author, same run, within 10 minutes) also requires the same
  `actor_ref`.
- **`edited_by_user_at`** is set when the current actor is the user and the item has an
  `external_key`. **`synced_at`** is set when a create or update carries source fields
  from a non-user actor.
- **API output** (A1). `TaskOut`, `EventOut` and `DocumentOut` gain:
  - `source`, `external_key`, `source_url`, `synced_at`, `edited_by_user_at` (tasks and
    events only)
  - `created_by_actor: ActorOut | null` and `updated_by_actor: ActorOut | null`

  `RevisionOut` gains `actor: ActorOut | null`. The existing fields (`created_by`,
  `author`, …) stay.
- **Detach** (A1): `POST /api/tasks/{id}/detach-source` and
  `POST /api/calendar/events/{id}/detach-source` clear all five source fields.

## 7. Timing (T)

The canonical store is `runs` and `tool_calls`. Messages reach their timing through
`messages.run_id`.

- **The run's `started_at` in the spec's sense** (when the server accepted the message)
  is `runs.created_at`. **`finished_at`** is `runs.ended_at`. The existing
  `runs.started_at` (first "running") keeps its meaning.
- **New columns on `runs`** (T):
  - `first_text_at` timestamptz, nullable
  - `waiting_ms` BigInteger, NOT NULL, default 0: the total time spent waiting for the
    user (approvals, `ask_user`, and `paused`, which waits for the user to resume; a
    top-level run also waits while one of its sub-agents waits) (change 2)
  - `waiting_since` timestamptz, nullable: set while waiting now
  - `first_text_waiting_ms` BigInteger, NOT NULL, default 0: how long the run had waited
    when its first text came, so "time to first text" leaves that wait out (change 3)
- **`tool_calls.started_at` / `ended_at`** exist already. T makes sure every finished
  call gets `ended_at`, including cancelled ones in `agent_finalize.finalize`, and that
  sub-agent calls get both.
- **Shared reader** (T), in `features/runs/service.py`: `run_timing(run, tool_calls:
  int) -> RunTiming`:

  ```python
  RunTiming {
    started_at, finished_at | None,
    outcome: "done" | "stopped" | "failed" | None,  # None while running
    first_text_at | None, first_text_waiting_ms, waiting_ms, waiting_since | None,
    tool_calls: int,
  }
  ```

  `outcome` maps from `runs.status`: completed → done, cancelled → stopped, failed →
  failed. Duration = `finished_at − started_at − waiting_ms`.
- **API** (T). `MessageOut.timing: RunTiming | null` (null on old messages and on user
  messages). T chooses how the browser learns the server's clock (a `server_now` field
  or a response header) and documents it in its report. Every response that carries
  `RunTiming` must let the UI correct for clock skew.
- **B2** reads `run_timing` for the automation run log and doesn't add timing columns.

## 8. Automations (B1; B2 builds on it)

B1 owns `features/automations/`, `tools/builtin/automation.py`,
`tools/builtin/schedules.py` and the Automations page. Names B2 depends on are binding;
the others are recommended, and B1 reports any change.

- **`automations.notify`** gains the value `agent_decides`. The values today are
  `always`, `on_failure` and `never`. Existing rows keep their value. New automations
  default to `agent_decides`. `on_failure` stays valid.
- **On `runs`** (binding, B1):
  - `outcome_line` Text, nullable: the model's one-line outcome
  - `nothing_to_do` Boolean, NOT NULL, default false
  - `changes` JSONB, nullable: the server-recorded list of changes,
    `[{tool, summary, ref?}]`
- **Recommended on `automations`:**
  - `state_note` Text, nullable
  - `tool_allowlist` JSONB, nullable (null = today's toolset)
  - `max_tool_calls` Integer, nullable
  - `max_runtime_s` Integer, nullable
  - `chat_retention_days` Integer, nullable (null = forever)
  - `contact_tools_allowed` JSONB, nullable: the tools allowed without approval for
    this automation
  - `change_check` JSONB, nullable: `[{tool, args}]`
  - `change_check_snapshot` JSONB, nullable
  - `run_anyway_hours` Integer, nullable
  - `failure_streak` Integer, NOT NULL, default 0
  - `last_error` Text, nullable
- **The existing `state` JSONB and `get_automation_state` / `set_automation_state`.**
  Existing automations keep working. The spec's `update_automation_state` (the text
  note) is B1's call: either evolve the existing pair or add the one tool. Two
  overlapping state mechanisms offered to the same run are not allowed. Report the
  choice.
- **"Reaches other people" in policy.** B1 adds an attribute to `policy/models.py`
  `Action` (recommended: `contacts_people: bool = False`). The tools concerned set it
  in `actions()`, and the engine forces `ask` for it in automation runs unless the
  automation allows that tool. Policy stays pure.
- **"Changed anything"** is decided from recorded tool calls. If B1 needs a marker on
  tools, it adds a ClassVar to `Tool` (add only, e.g. `changes_state: ClassVar[bool]`).
- **Run log endpoint** (B1): `GET /api/automations/{id}/runs` returns
  `[{run_id, status, created_at, ended_at, outcome_line, nothing_to_do, changes,
  conversation_id | null, error | null}]`. B2 adds `timing: RunTiming` to each row.

## 9. Tools: who changes what

Descriptions say that folders mean location and properties mean category (A2 for the
document tools, A3 for tasks and events).

| Tool | Package: parameters / change |
|---|---|
| `create_event` | A1: `source`, `external_key`, `source_url`; result for an existing key. A3: `properties`, `links` |
| `update_event` | A1: `source_url` (key immutable), sets `synced_at`/`edited_by_user_at`. A3: `properties`, `links_add`, `links_remove` |
| `list_events` | A1: `source`, `external_key`, `query`; date range optional with them. A3: `properties` |
| `get_event` **new** | A1: event in full with source and provenance. A3: adds properties, links, backlinks |
| `delete_event` | A1: result wording only if needed |
| `create_task` | A1: `source`, `external_key`, `source_url`. A3: `properties`, `links` (`tags` unchanged) |
| `update_task` | A1: as `update_event`. A3: `properties`, `links_add`, `links_remove` |
| `list_tasks` | A1: `source`, `external_key`. A3: `properties` |
| `get_task` | A1: source and provenance. A3: properties, links, backlinks |
| `search_documents` | A2: `folder`, `project`, `properties`, `updated_after`, `updated_before`, `scope`, `include_archived` |
| `list_documents` | A2: the same filters plus `group_by` |
| `read_document` | A2: properties block, id/reference accepted, "moved to" note. A3: backlinks (count and the first few) |
| `write_document` | A2: `properties`, folder defaults. A1: nothing (provenance comes from the actor) |
| `edit_document` | A2: id/reference accepted, old paths resolved |
| `set_document_properties` **new** | A2 |
| `list_properties` **new** | A2; A3 extends the counts to tasks and events |
| `create_schedule`, `update_schedule`, `list_schedules` | B1: the per-automation settings |
| `update_automation_state` (or evolved `set_automation_state`) | B1 |
| `send_notification` | B1: may mark the run as having notified; input unchanged |

T adds or changes no tools. B2 adds or changes no tools.

## 10. Migrations

- **Each package keeps its own migrations and never edits another package's.**
- **Revision ids are 4-digit strings, with a reserved range per package:**

  | Package | Range |
  |---|---|
  | A1 | `0035`–`0039` |
  | T | `0040`–`0044` |
  | B1 | `0045`–`0049` |
  | A2 | `0050`–`0059` |
  | A3 | `0060`–`0069` |
  | B2 | `0070`–`0079` |

  File name: `NNNN_<description>.py`, as today.
- **Chaining.** A package's first migration has `down_revision` = the head of the branch
  it started from (`"0034"` in wave 1). Its later migrations chain on its own. At merge
  the orchestrator only changes the `down_revision` of each package's first migration,
  so the history stays linear in merge order (A1, T, B1, A2, then A3, B2). The numbers
  are not reused.
- **Every migration has a working `downgrade()`.** `alembic check` must pass: models and
  migrations agree.
- **Data migrations** (A3's tags, A2's built-in property definitions) must be idempotent
  and must leave existing behaviour unchanged.
- **Never run a migration against the live database.**

## 11. File ownership (hotspots)

"Add only" means: add new functions, fields, branches or calls. Don't reformat, move,
rename or restructure existing code, and don't change existing behaviour except where
your spec part requires it. When you need to change an existing function's body, keep
the change local and say so in your report.

| File / area | Wave 1 | Wave 2 |
|---|---|---|
| `core/actor.py`, `core/refs.py`, `lib/appLinks.ts` | orchestrator only; report needed changes | same |
| `runtime/agent.py` | T (timing: waiting, first text, call ends); B1 (allowlist, limits, approval context, changes). Add only; neither restructures `_execute`/`_settle_call` | — |
| `runtime/agent_finalize.py`, `runtime/lifecycle.py`, `runtime/chat.py` | T, B1: add only | B2 |
| `runtime/agent_snapshot.py` | B1 (per-automation model, limits, allowlist) | — |
| `features/runs/models.py`, `features/runs/service.py` | T (timing columns, `run_timing`); B1 (`outcome_line`, `nothing_to_do`, `changes`): add only | B2 reads |
| `features/runs/schemas`/routers, `conversations/schemas.py` (`MessageOut`) | T | — |
| `features/documents/service.py` (save path) | A1: actor on revision and document rows, inside `_apply`/`_add_revision`/`create`. A2: front matter, properties index, path history, startup reconcile, as separate helpers called after the write. Neither restructures `save`/`create`/`_apply` | A3: link extraction after the write |
| `features/documents/router.py`, `models.py` | A1 (output fields, provenance columns); A2 (properties, path history, search params): add only | A3 |
| `features/tasks/*`, `features/calendar/*`, `features/trash/*` | A1 | A3 |
| `tools/builtin/tasks.py`, `events.py` | A1 | A3 |
| `tools/builtin/docs.py` | A2 | A3 (`read_document` backlinks) |
| `tools/builtin/automation.py`, `schedules.py`, `notify.py` | B1 | — |
| `tools/base.py` | B1 may add ClassVars; nobody changes existing fields | — |
| `tools/registry.py` | A1 (`get_event`), A2 (2 tools), B1 (automation tools, allowlist filter): add only | A3 |
| `policy/models.py`, `policy/engine.py`, `policy/presets.py` | B1 (contact rule); A2 adds a preset category only if a new capability is needed | — |
| `features/automations/*`, `jobs/scheduler.py` (automation tasks) | B1 | B2 |
| `jobs/runner.py`, `jobs/scheduler.py` (other) | A2 (reconcile job, if any); B1: add only | A3 |
| `knowledge/index.py`, `features/search/*` | A2 | — |
| `features/links/*` | A2 (`on_moved` records path history: add only) | A3 |
| `db/models.py` (import list), `api/router.py` | everyone: add one line per new module, nothing else | same |
| `features/settings/sections.py`, settings UI | A2 (properties section), B1 (automation defaults if needed): add only | — |
| `tests/conftest.py` | orchestrator only | same |
| `frontend/src/features/chat/components/MessageBubble.tsx`, `features/agents/components/RunActivity.tsx`, `features/chat/runStream.ts` | T | — |
| `frontend/src/features/documents/*` | A1 (provenance in `DocumentInfo` and `RevisionsDialog` only); A2 (everything else: properties panel, front matter, warnings) | A3 (backlinks, `[[` picker) |
| `frontend/src/features/calendar/*`, `features/tasks/*` | A1 | A3 |
| `frontend/src/features/automations/*` | B1 | B2 |
| `frontend/src/features/search/*`, `app/Sidebar.tsx`, `app/router.tsx` | A2 (A1 may add query-param handling in the calendar page, not the router) | A3 |
| `frontend/src/features/settings/navigation.ts` (`PAGE_INFO`) | A2 if it adds a page | — |
| `frontend/src/api/openapi.json`, `schema.d.ts` | everyone regenerates and commits; **at merge the orchestrator regenerates them from the merged code** (never hand-merged) | same |
| Locales `frontend/src/locales/{uk,ru}/*.ts` | each package puts its new texts in **its own new files**: A1 `sources.ts`, A2 `properties.ts`, T `timer.ts`, B1 `automations.ts` (its existing area) | A3 `linking.ts`, B2 `automations.ts` |

A new feature folder (`features/properties/`, `features/views/`, `features/provenance/`)
belongs to the package that creates it.

## 12. Environment per package

Each package has its own worktree, branch, test database, Valkey database and ports.
Tests run against `TEST_DATABASE_URL` and `TEST_REDIS_URL` (see `tests/conftest.py`).
Nobody connects to the live Anemo instance or its database.

| Package | Worktree | Branch | Test DB | Valkey DB | Ports (API / Vite) |
|---|---|---|---|---|---|
| A1 | `../anemo-a1` | `feat/a1` | `anemo_test_a1` | 1 | 8101 / 5201 |
| A2 | `../anemo-a2` | `feat/a2` | `anemo_test_a2` | 2 | 8102 / 5202 |
| T | `../anemo-t` | `feat/t` | `anemo_test_t` | 3 | 8103 / 5203 |
| B1 | `../anemo-b1` | `feat/b1` | `anemo_test_b1` | 4 | 8104 / 5204 |
| A3 | `../anemo-a3` | `feat/a3` | `anemo_test_a3` | 5 | 8105 / 5205 |
| B2 | `../anemo-b2` | `feat/b2` | `anemo_test_b2` | 6 | 8106 / 5206 |

Worktree paths are relative to the main checkout (`C:\Users\user\Documents\Projects\anemo`).
How to run the tests is in `docs/specs/TESTING.md`, written once the test environment is
settled.

## Change log

- Wave 0: first version.
- Change 1 (wave 1, after the A1 review): `external_key_tombstones`, so that purging a
  synced item from the trash doesn't let a sync recreate it. A1 builds it in its
  existing migration range (0035–0039). No other package is affected.
- Change 2 (wave 1, after the T review): `waiting_ms` also counts `paused` time, and a
  top-level run waits while one of its sub-agents waits. B2 shows the duration as
  `finished_at − started_at − waiting_ms` and needs nothing else.
- Change 4 (before wave 2): section 5a names the link index `object_links` for A3.
  The wave-1 contracts left it out. Only A3 is affected.
- Change 3 (wave 1, after the T review): `runs.first_text_waiting_ms` and
  `RunTiming.first_text_waiting_ms`. Time to first text is
  `first_text_at − started_at − first_text_waiting_ms`. T only.
