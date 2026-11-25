# Contracts for round 4 (event triggers, chat recall, activity log, bulk changes, code wait, device files, desktop auto-update)

Shared names, data shapes and file ownership for the workstreams of 2026-11-25. Each
workstream has its own branch, worktree and pull request; nothing is merged into `main`
by the agents. All branches start from `docs/round4-contracts` (this file, the round's log,
the roadmap's round-4 table and the stub `app/core/activity.py`), which starts from
`origin/main` at `f87a49b`. If a workstream can't do its work within this file, it says so
in its report and pull request (the orchestrator decides); it doesn't work around it.

| Id | Workstream | Branch | Spec it writes | Wave |
| --- | --- | --- | --- | --- |
| T | Event triggers (internal events, webhooks, wake me, rails, tools, UI) | `feat/event-triggers` | `16-event-triggers.md` | 1 |
| R | Chat recall (`search_chats`, `read_chat`) | `feat/chat-recall` | `18-chat-recall.md` | 1 |
| A | Activity log with undo | `feat/activity-log` | `19-activity-log.md` | 1 |
| B | Bulk task and event changes | `feat/bulk-changes` | `20-bulk-changes.md` | 1 |
| W | Waiting on a code job (`code_status` `wait_s`) | `feat/code-wait` | `21-code-wait.md` | 2 |
| F | Files between devices and the workspace | `feat/device-files` | `22-device-files.md` | 2 |
| M | MCP triggers (notifications from MCP servers fire triggers) | `feat/mcp-triggers` (from T's branch) | `17-mcp-triggers.md` | 2 |
| U | Anemo Desktop auto-update | `feat/desktop-auto-update` (after F) | `23-desktop-auto-update.md` | 3 |

M is split out of the triggers workstream because it needs a long-lived MCP session
listener in the worker (today's MCP client opens one connection per call); it builds on
T's tables and `emit()`, so it starts from T's branch and its pull request is based on
`feat/event-triggers`. U waits for F because both change `desktop/` and its version.

The security model stays as it is (`docs/security.md`): tool results and event payloads
are untrusted data; contact and outward tools still ask in automation runs; every new
capability gets its own permission category; device actions only on trusted computers.
Nothing personal to one user goes into the repo.

## 1. Events (owner: T)

### 1.1 Emitting

One function, `app/features/triggers/events.py`:

```python
async def emit(db: AsyncSession, type: str, data: dict[str, Any], *,
               subject: str | None = None) -> None
```

- Adds one row to the outbox table `trigger_events` **in the caller's transaction**
  (it doesn't commit; the event exists only if the change it describes commits) and makes
  sure a dispatch job runs after the commit. Never raises for a bad payload in production
  code paths: it logs and drops (an event must never break the change that caused it).
- `actor_ref` is taken from `current_actor()` (`app/core/actor.py`), never from `data`.
  The trigger depth (loop protection, §2.4) is taken from the run the actor belongs to.
- `subject`: the id of the object the event is about (a task id, a job id…), used for
  coalescing and for filters that name one object.
- `data`: ids and short metadata only (≤ 16 KB as compact JSON, longer strings cut). Text
  that came from outside or from a model (a webhook body, a job's error tail, a document
  title an agent wrote) may be in it, but is always treated as untrusted when it reaches a
  model (§2.5). No secrets, no chat message contents, no file contents.

Where events come from (T places these; nobody else adds `emit` calls this round, except
M for `mcp.notification` and F if it adds `file.created` for a pulled file, see §6):

- **Tasks, calendar events, documents, code jobs**: from a SQLAlchemy session listener
  (`after_flush`) on `Task`, `CalendarEvent`, `Document` and `CodeJob`, registered once
  in `features/triggers/`. This catches every write path (API, tools, scripts, plugins,
  sync) **without editing** `features/tasks/service.py`, `features/calendar/service.py`,
  `features/documents/service.py` or `features/code_sessions/ingest.py`, which belong to A
  (and, for ingest, are left alone) this round.
- Everything else (devices, files, automation failures, approvals, webhooks) by an explicit
  `emit` at the one place it happens, in a separate small hunk.

### 1.2 Types

Names are `<object>.<verb>`; `data` always has the ids named below, and may have more
(the T spec lists every field). A filter (§2.3) can match on any top-level field.

| Type | `subject` | `data` (at least) |
| --- | --- | --- |
| `task.created`, `task.changed`, `task.completed`, `task.deleted` | task id | `task_id, title, status, project_id, tags, fields` (`fields`: the names that changed, on `changed`) |
| `calendar_event.created`, `calendar_event.changed`, `calendar_event.deleted` | event id | `event_id, title, start_at, end_at, project_id, fields` |
| `document.created`, `document.changed`, `document.deleted` | document id | `document_id, path, title, project_id` |
| `code_job.started`, `code_job.ended` | job id | `job_id, thread_id, device_id, device, project, state` (`ended`: `done \| failed \| cancelled \| exited_without_result`), `conversation_id` (the chat that started it, if any) |
| `device.online`, `device.offline` | device id | `device_id, name, kind` |
| `file.created` | workspace path | `path, size, mime` (a file that appeared in the workspace through Anemo: upload, agent, extension, device pull) |
| `automation.run_failed` | automation id | `automation_id, run_id, name, failure_streak` |
| `approval.waiting` | approval id | `approval_id, run_id, conversation_id, tool, summary` |
| `webhook.received` | trigger id | `trigger_id, content_type, body` (parsed JSON or text, ≤ 64 KB, untrusted) |
| `mcp.notification` (M) | server id | `server_id, server, method, uri?, params` (untrusted) |

A new type later is added to this table and to the catalogue in `features/triggers/`
(one list, with a label and the filterable fields, which the UI and the tools read).

### 1.3 Tables (T's migration)

- `trigger_events` (outbox): `id` (UUIDv7), `type` String(60), `subject` String(200)?,
  `data` JSONB, `actor_ref` String(120), `depth` Integer default 0, `created_at`,
  `dispatched_at`?. Partial index on `created_at` WHERE `dispatched_at IS NULL`. Pruned
  after 7 days by a periodic task.
- `triggers`: `id`, `automation_id`? (FK automations, CASCADE), `conversation_id`? (FK
  conversations, CASCADE; exactly one of the two is set), `event_type` String(60),
  `filter` JSONB, `once` bool, `expires_at`?, `debounce_s` int, `max_per_hour` int,
  `enabled` bool, `webhook_secret_id`? (FK `secrets`, for `webhook.received`), `note`
  (why the agent set it), `created_by` (actor reference), `fire_count`, `last_fired_at`,
  `last_event_id`, `pending_since`? (debounce window open) and whatever else T needs.
- `runs.options["automation"]["trigger"]` is `"event"` for a run an event started, and
  `runs.options["event"]` holds `{id, type, subject, at, coalesced}` so the run log and
  the chat can say which event started it. No new column on `runs` for that.

## 2. Triggers (owner: T)

### 2.1 Design decided here

- A trigger is **its own row** (`triggers`), owned either by an automation (it starts a
  run of that automation, with every rail of spec 02: tool allowlist, notify mode incl.
  `agent_decides`, model, limits, state note, contact tools ask, failure streak, no
  overlapping runs) or by a conversation ("wake me": it continues **that** chat with a new
  turn carrying the event). An automation can have a schedule, triggers, or both; one that
  has only triggers has the schedule `{"type": "manual"}` (as "Only when started" for
  scripts). Plugins' declared automations may declare triggers through the same rows if
  it's cheap (T decides; otherwise a roadmap line).
- Tools (T, in `tools/builtin/triggers.py`, new): `create_trigger`, `list_triggers`,
  `update_trigger`, `delete_trigger`. `create_schedule` / `update_schedule` /
  `list_schedules` get a `triggers` list too, so an automation and its triggers are
  proposed and confirmed in one step. T's spec justifies the final shape; the names above
  are reserved for T.
- Wake me is `create_trigger` with `target: "this_chat"`. The new turn is **not** the
  user's words: it's a user-role message whose content is an event block (no new message
  role, so providers need no change), shown in the chat as an event card, and the event
  reaches the model inside an untrusted-data block.

### 2.2 Permissions (T appends two categories to `policy/presets.py`)

| Capability | Label | Default | Notes |
| --- | --- | --- | --- |
| `triggers.manage` | "Event triggers" | ask | Creating a trigger for an automation, a webhook, or changing what or when one fires **asks every time**, whatever the level (as schedules do today). Deleting or turning one off may follow the level. |
| `triggers.wake` | "Wake this chat on events" | ask_dangerous | A one-shot wake-me on an internal event with an expiry ≤ 24 h is `safe`; repeating, longer, or on a webhook is `moderate`. |

Runs started by a trigger can't create or change triggers or schedules (as scheduled runs
can't today).

### 2.3 Matching, filters, coalescing, limits

- A filter is a flat object of `field: value` (equality; a list means any of; strings
  compare case-insensitively; `tags` matches when the item has the tag). Unknown fields
  are refused when the trigger is saved, against the catalogue (§1.2).
- `debounce_s` (default 0, max 3600): events matching within the window after the first
  one are coalesced into one firing; the run gets the newest event and the count.
- `max_per_hour` (default 12, max 120): firings beyond it are dropped and logged on the
  trigger. A global ceiling for all triggers is a setting (`AutomationSettings`).
- `once`: the trigger is turned off after its first firing. `expires_at`: not fired after
  it, pruned a day later. Wake-me triggers always have an expiry (default 24 h, max 30 days).
- No overlapping runs (spec 02): an automation's trigger that fires while a run is busy is
  coalesced into one follow-up firing after it ends, not stacked. A wake-me on a chat
  whose run is still going waits for it to end.
- "Pause all" stops triggers as it stops schedules.

### 2.4 Loop protection

- An event whose `actor_ref` is a run of the same automation never fires that
  automation's triggers; a wake-me never fires on an event its own chat's runs caused.
- `depth`: an event caused by a run that a trigger started has the depth of that run's
  event + 1; events with depth ≥ 3 fire nothing (logged). Together with `max_per_hour`,
  that caps any chain.

### 2.5 Untrusted payloads

The event goes into the run's context the way spec 02's change check results do: a
section that says it is data, with the payload inside `<untrusted_data>` from
`app/tools/untrusted.py` `untrusted(source, text)` (already used for tool results, web
pages and plugin text; reuse it, don't invent another marker). The webhook body and MCP params are never put in a system prompt or a tool
description.

### 2.6 Webhooks (spec 02 §2.8, now built)

`POST /api/hooks/{trigger_id}` (not behind login, mounted outside `protected`): the
request is accepted only with a valid `X-Anemo-Signature: sha256=<hex>` HMAC of the raw
body with the trigger's secret (shown once on creation, stored in `secrets` encrypted,
rotatable), and a timestamp header within 5 minutes (replays refused). Body ≤ 64 KB;
answer `202` with no body content worth anything to a caller; unknown or disabled
trigger, bad signature: the same `404`. Rate-limited per trigger. `docs/security.md` and
`docs/deployment.md` say how to expose only `/api/hooks/*` (Cloudflare Tunnel rule).

### 2.7 API (T)

`/api/triggers` (CRUD, `TriggerIn`/`TriggerPatch`/`TriggerOut`), `/api/triggers/{id}/secret`
(rotate, recent auth), `/api/triggers/catalogue` (event types and their fields), and the
automation run log entry gains `event: {type, summary, at, coalesced} | None`. Exact
shapes are T's (in its spec); M and the UI use them.

## 3. Activity log (owner: A)

- Table `activity` (A's migration): `id`, `created_at` (indexed DESC), `actor_ref`
  String(120), `action` String(40) (`created | changed | completed | deleted | restored |
  reverted | moved | undone`), `object_type` String(20) (`task | event | document | file |
  project | …`), `object_id` String(200)? (a UUID, or a workspace path for files),
  `summary` String(300), `before` JSONB?, `after` JSONB?, `undo` JSONB? (how to undo:
  `{"kind": "fields" | "trash_restore" | "file_revert" | "delete_created", …}`),
  `group_id` UUID? (indexed), `group_label`?, `run_id` UUID?, `undone_at`?, `undone_by`?.
  Kept 90 days (periodic prune).
- One writer, `features/activity/service.py`:

  ```python
  async def record(db: AsyncSession, *, action: str, object_type: str,
                   object_id: str | None, summary: str, before: dict | None = None,
                   after: dict | None = None, undo: dict | None = None) -> None
  ```

  Part of the caller's transaction (doesn't commit). Actor from `current_actor()`, run
  from the actor (automation runs) or the chat's run in flight, group from
  `app/core/activity.py` `current_group()` (the stub committed in wave 0; B sets it).
- A places the `record` calls where the provenance helpers (`sources.record_created` /
  `record_changed`, `updated_by_ref = …`) and `record_change` already run: tasks,
  calendar events, documents, trash (delete / restore), file writes and reverts
  (`workspace/files.py`, `workspace/revert.py`), and projects if cheap. `runs.changes`
  (`record_change`) stays as it is; the two are not merged this round.
- Undo is user-only (HTTP, `POST /api/activity/{id}/undo`, `POST
  /api/activity/groups/{group_id}/undo`): no agent tool. An undo checks the object is
  still as the entry left it (else `409 activity_conflict` with what differs; a `force`
  flag as for file revert), writes its own `undone` entry, and is itself not undoable
  except by undoing again through the object's own history.
- The page is `features/activity/ActivityPage.tsx` (route `/activity`, PAGE_INFO,
  `PageId` "activity", command palette), filters: actor (user, assistant, automation,
  script, plugin, trigger-started), object type, object, time range.

## 4. Bulk changes (owner: B)

- B decides between `update_tasks` / `update_events` and a batch form of `update_task` /
  `update_event`, and justifies it in its spec. Either way: up to 100 items per call,
  per-item results (`ok` / error per item, nothing silently skipped), and **one**
  `actions()` list for the call, so the existing approval path asks once for the batch
  (the approval shows every item). Capabilities stay `tasks.write` / `calendar.write`.
- The batch runs inside `activity_group(label)` (`app/core/activity.py`), so A's entries
  share a group. B doesn't write activity rows itself.
- B owns `tools/builtin/tasks.py` and `tools/builtin/events.py` this round. Service
  functions B needs are added at the end of `features/tasks/service.py` /
  `features/calendar/service.py` as new functions; existing ones are not restructured
  (A adds `record` calls inside them).

## 5. Chat recall (owner: R)

- Tools `search_chats` and `read_chat` in `tools/builtin/chats.py` (new), capability
  `chats.read` ("Read earlier chats", default `autonomous`; both actions are `safe`;
  automations get them only when their allowlist names them). R appends the category.
- Search: full text over `messages.text_plain` and titles (the existing `tsv`), plus
  semantic results when an embedding model is set (R decides whether message chunks go
  into `knowledge_chunks`; a new `source_type` value needs R's migration). Scope: the
  current chat's project by default, `"all"` like `search_documents`. Never the chat the
  run is in (it has that already), never deleted or temporary chats, never chats past an
  automation's retention. `read_chat`: pages of messages (by `seq`, with a cursor), text
  only (tool calls summarised, attachments named).
- Results are wrapped with `app/tools/untrusted.py` `untrusted()` (they hold earlier tool results and other
  people's text). Feature tools: listed in `FEATURE_TOOLS` only if a page owns chats
  (it doesn't: the tools are always offered).

## 6. Device files (owner: F)

- Tools `device_file_get` (device → workspace) and `device_file_put` (workspace → device)
  in `tools/builtin/device_files.py` (new), capability `device.files` ("Files on your
  computers", default `ask`), only for **trusted** computers whose client offers it
  (`device.offer` gets `"files": true`, Anemo Desktop 1.7.0).
- Protocol: a new §8 in `docs/device-contracts.md` (F owns §8 and the 1.7.0 line of §6):
  chunked transfer over the existing WebSocket (`device.command` actions
  `file_stat`, `file_read`, `file_write_begin` / `file_write_chunk` / `file_write_end` or
  an equivalent F designs), SHA-256 per file and per chunk, size limit (default 50 MB,
  setting), paths on the device are the device's own absolute paths (opaque strings on
  the server, as in §7), only inside folders the client allows (F decides the default and
  writes it in the spec).
- Writes into the workspace go through `app.workspace.files` / `fs_guard` and are
  recorded as run file changes (revertible, as agent writes are today). Writes onto the
  device never overwrite an existing file unless `overwrite: true`, which raises the risk
  to `dangerous`.
- F bumps the Windows and macOS client versions (CI's "App versions" check) to 1.7.0 and
  adds the manual tests to `desktop/MANUAL-TESTS.md` (and the Mac checklist).

## 7. Code wait (owner: W) and the code-job event (owner: T)

- W adds `wait_s` (0–300, default 0) to `code_status`: the call returns as soon as the
  job's state changes or it ends, else after `wait_s` with the state then. It waits on the
  job's existing Valkey stream (`code:{job_id}`, `XREAD BLOCK`), not by polling the
  database or the device; the device does nothing new. A run being cancelled ends the wait
  at once. W owns `tools/builtin/code.py` this round and may point `code_start`'s
  description at `wait_s` and at `create_trigger` (`code_job.ended`, `target: this_chat`).
- T emits `code_job.started` / `code_job.ended` from the ORM listener (§1.1); W doesn't.

## 8. Desktop auto-update (owner: U, wave 3)

- U checks GitHub Releases (the tags `desktop-v<version>` that `release.yml` and
  `auto-release.yml` publish) on start and every 6 hours, verifies the download against
  the release's `SHA256SUMS-desktop*.txt` (and the signature where the platform has one),
  installs on quit or from a tray item "Restart to update", and has a setting to turn it
  off. No server of Anemo's is involved. U owns `desktop/` (after F is merged),
  `.github/workflows/release.yml` and `auto-release.yml`, and §6 of
  `docs/device-contracts.md` only if the server needs to know anything (it shouldn't).

## 9. File ownership (hotspots)

"Append" means: add your lines, don't reformat, move or rename what is there.

| File | Owner(s) and how |
| --- | --- |
| `docs/roadmap.md` | Each workstream: its own row of the *Round 4* table (status → done, PR number) and removing its own item from *Next*. Nothing else. |
| `docs/specs/ORCHESTRATION-LOG-round4.md`, this file | orchestrator |
| `docs/features.md` | T: *Automations* (+ a *Triggers* subsection) and *MCP servers* (M); R: a *Chat recall* paragraph in *Search*; A: a new *Activity* section; B: *Tasks and calendar*; W and F: *Devices*; U: *Devices* (a paragraph on updates). Each edits only its part. |
| `docs/security.md` | T: *Webhooks* (new) and the *Schedules* row; R: one row "Earlier chats"; F: *Devices*; U: a paragraph in *Devices*. Separate hunks. |
| `docs/device-contracts.md` | F: §8 and the 1.7.0 line of §6; U: only if needed. |
| `backend/app/tools/registry.py` | T, R, F append to `BUILTIN_TOOLS` (and `FEATURE_TOOLS` "automations" for T's tools) |
| `backend/app/policy/presets.py` | T (two categories), R (one), F (one): append |
| `backend/app/features/automations/`, `tools/builtin/schedules.py`, `frontend/src/features/automations/` | T |
| `backend/app/runtime/` (dispatch, agent, agent_prompt, turn context) | T (the event turn and run context); others don't touch |
| `backend/app/features/triggers/` (new), `tools/builtin/triggers.py` | T; M adds its listener as new files under `features/triggers/` or `mcp/` |
| `backend/app/mcp/client.py`, `features/mcp/` | M |
| `backend/app/features/tasks/service.py`, `calendar/service.py`, `documents/service.py`, `trash/`, `workspace/revert.py` | A (`record` calls); B appends new functions at the end of tasks/calendar services |
| `backend/app/workspace/files.py` | A (`record` calls); T (`file.created` emit, one hunk); F only calls it |
| `backend/app/features/devices/ws.py`, `relay.py` | T (`device.online` / `device.offline` emits, one hunk each); F (file transfer messages, new functions) |
| `backend/app/features/runs/service.py` | T (`approval.waiting` emit, one hunk) |
| `backend/app/tools/builtin/tasks.py`, `events.py` | B |
| `backend/app/tools/builtin/code.py` | W |
| `backend/app/tools/builtin/chats.py` (new), `features/conversations/` search helpers | R |
| `backend/app/features/activity/` (new), `frontend/src/features/activity/` (new) | A |
| `backend/app/features/settings/sections.py` | T (trigger ceiling in `AutomationSettings`), A (`PageId` "activity"), F (device file size limit): append |
| `frontend/src/app/router.tsx`, `features/search/pages.ts`, `features/settings/navigation.ts` | A (the Activity page): append |
| `frontend/src/features/chat/` | T (the event card for a wake-me turn) |
| `desktop/` | F (wave 2), then U (wave 3) |
| `.github/workflows/*` | U only |
| `frontend/src/api/openapi.json`, `schema.d.ts` | generated: each PR regenerates after its last backend change; the integration branch regenerates after every merge |
| `frontend/src/locales/*` | each adds its own keys in its own area file |

## 10. Migrations

Latest on `main`: `0080_plugin_assets`. Each branch's migration has `down_revision =
"0080_plugin_assets"`, with its own number so ids never collide:

| Workstream | Revision |
| --- | --- |
| T | `0081_event_triggers` |
| A | `0082_activity` |
| R | `0083_chat_recall` (only if needed) |
| F | `0084_device_files` (only if needed) |
| M | `0085_mcp_triggers` (only if needed; `down_revision` `0081_event_triggers`) |
| B, W, U | none expected; if one is needed after all, ask (report) first |

On `integrate/round4` the orchestrator re-chains them in merge order (T, A, B, R, then W,
F, M, U). Whichever pull request is merged into `main` second re-points its
`down_revision` at the one merged before it (a one-line commit; noted in its PR).

## 11. Environment on this VM

No Docker, no `make`. The local toolchain is `C:\dev\anemo\.local-env\` (its `README.md`,
`KNOWN-FAILURES.md`): `sh backend.sh <worktree> <name> check|lint|gen-api|<pytest args>`
with its own test database `anemo_test_<name>` and Redis db per name. Names: T `e`, R `f`,
A `g`, B `h`, W `a`, F `b`, M `c`, U `d`. Never run two pytest processes on one name.
e2e (Playwright) needs the Docker stack: write the spec, and let CI's e2e job run it.
CI on the pull request (Linux, plus the macOS job) is the final check: push, open a
**draft** pull request, watch `gh pr checks`, fix what fails.
