# Event triggers: an event wakes an automation or a chat

Workstream T of round 4 (`docs/specs/CONTRACTS-round4.md` §1, §2, §7). Before this, an
automation ran only on its schedule (and its change check); now something that happens
can start it, and an agent in a chat can ask to be woken when something happens ("tell
me when this Claude Code job ends"). Spec 02's §2.8 (webhooks) is built here too.

## 1. The design in one paragraph

Every change that can wake something writes an **event** into an outbox table
(`trigger_events`) in its own transaction. After the commit, a worker job matches the
pending events against the **triggers** (`triggers`): each trigger names an event type, a
filter on the event's fields, and limits; it belongs either to an **automation** (a
firing starts a run of it, with every rail spec 02 gives automation runs) or to a
**conversation** (a firing continues that chat with a new turn that carries the event,
"wake me"). The event's payload reaches a model only inside an untrusted-data block.

## 2. What exists and what is reused (verified in the code)

| Need | Reused |
| --- | --- |
| Starting an automation run | `automations.start_run(..., trigger="event", event=…)`: the same rails as a scheduled run (tool allowlist, notify modes incl. `agent_decides`, model, limits, state note, contact tools ask, `on_ask`, retries, failure streak, retention, plugin gate) |
| No overlapping runs | `automations.busy_run` (the dispatcher holds a firing while a run works) |
| The run's context | `automations/context.py` `run_context` gets an event section, like the change check's |
| Marking outside content | `app/tools/untrusted.py` `untrusted()` |
| A chat turn | `conversations.service.send_event_turn` (new, next to `send_turn`; same lock: one run per chat) |
| Secrets | `features/secrets` (the webhook signing secret, encrypted) |
| Recent password | `require_recent_auth` (rotating a webhook secret) |
| A sync read in `actions()` | `core.db.read_sync` (the trigger tools' approval text) |
| Pause all | `AutomationSettings.paused` |

## 3. Events

### 3.1 Emitting (`features/triggers/events.py`)

```python
async def emit(db, type, data, *, subject=None) -> None        # in the caller's transaction
async def emit_now(type, data, *, subject=None, actor=None, depth=None) -> None  # own session
```

- `emit` adds a `TriggerEvent` row and one `triggers.dispatch` job per transaction; a
  bad payload never makes it raise (it is logged and dropped). A database error is
  raised, not logged: it leaves the caller's transaction unusable anyway and is most
  likely the caller's own (queuing the job flushes the caller's pending rows), and
  hiding it would only turn it into a `PendingRollbackError` at the caller's commit.
  The "is anyone listening" lookup runs under `no_autoflush`, so it never flushes the
  caller's rows. `actor_ref` comes from `current_actor()`, `depth` from
  `caused_at_depth()` (§4.4).
- **An event nobody waits for is not stored**: `emit` (and the listener) first check that
  an enabled trigger of that type exists. Without triggers, nothing changes for anyone
  (no rows, no jobs), and document autosaves don't fill the outbox.
- `data` is cut to fit: strings over 2,000 characters are cut, then 200, and an event
  still over its type's limit (16 KB; 70 KB for a webhook) is dropped and logged.

### 3.2 Where they come from

| Source | How |
| --- | --- |
| Tasks, calendar events, documents | An ORM session listener (`listener.py`): `after_flush` collects what the flushed rows mean (attribute history: which fields changed), `after_flush_postexec` writes the rows. No edit to their services. |
| Code jobs | The same listener. `ingest.py` makes job rows with a Core `INSERT … ON CONFLICT DO NOTHING`, which the ORM never sees as new: `do_orm_execute` notes the inserted id and state, and `before_commit` emits `code_job.started` (and `ended` if the job ended in the same transaction). `ended` is the step from `running` to a terminal state (terminal states are sticky; an `exited_without_result` that a late result turns into `done` doesn't end it twice). A job first seen already ended (back-filled) emits nothing, as it doesn't notify (code-sessions D10). |
| Devices | `devices/ws.py`: `device.online` when a connection takes a device that had none; `device.offline` when the last one closes. A device whose entry only times out (a crash) sends no `offline`. |
| Files | `workspace/files.py` `write_bytes` calls a hook for a file that didn't exist; it runs in a thread (`asyncio.to_thread`), so `files_hook.py` hands `emit_now` to the process's event loop with the caller's actor and depth. Uploads, agent writes, the extension, documents. |
| Automation failures | `automations.count_failure` (a run failed for good, after its retries), as the automation's own run. |
| Approvals | `runs.service.set_status`, when a run starts waiting: one `approval.waiting` per pending approval, as the run's own actor. |
| Webhooks | `webhooks.receive` (§6), as the actor `external`. |

A row that is created and changed in the same transaction (a document gets its title in
a second flush) makes one `created` event with the final data, not `created` + `changed`.
`task.completed` replaces `task.changed` when the status becomes `done`. Bookkeeping
fields (`updated_at`, provenance, sort order, index hashes, a document's size and
mtime) are not changes. Bulk `UPDATE`/`DELETE` statements make no events; no service
changes these fields that way.

### 3.3 The catalogue (`features/triggers/catalogue.py`)

One list of `EventType(type, label, description, fields, max_data, addressed)`, read by
the dispatcher (which fields may be filtered on), `GET /api/triggers/catalogue` (the
Automations page's picker) and the tools' descriptions. A request lists the types once, in
the first of create_trigger, create_schedule, update_schedule it offers; the others point
to it (`say_event_types_once` in `tools/builtin/triggers.py`).

| Type | `subject` | `data` |
| --- | --- | --- |
| `task.created/changed/completed/deleted` | task id | `task_id, title, status, project_id, tags, priority, due_date, parent_id` (+ `fields` on `changed`) |
| `calendar_event.created/changed/deleted` | event id | `event_id, title, start_at, end_at, all_day, project_id, task_id` (+ `fields`) |
| `document.created/changed/deleted` | document id | `document_id, path, title, project_id` (from its folder `documents/<slug>/`) |
| `code_job.started/ended` | job id | `job_id, thread_id, device_id, device, project, title, state, conversation_id` |
| `device.online/offline` | device id | `device_id, name, kind` |
| `file.created` | path | `path, size, mime` |
| `automation.run_failed` | automation id | `automation_id, run_id, name, failure_streak` |
| `approval.waiting` | approval id | `approval_id, run_id, conversation_id, tool, summary` |
| `webhook.received` | trigger id | `trigger_id, content_type, body` (JSON or text, ≤ 64 KB) |

Extra fields beyond the contract: tasks' `priority`, `due_date`, `parent_id`; events'
`all_day`, `task_id`; code jobs' `title`. No new types were added beyond the contract's.

**Where M (MCP triggers) plugs in**: append `EventType("mcp.notification", …)` to
`EVENT_TYPES` and call `events.emit_now("mcp.notification", {...}, subject=server_id)`
from its listener (new files under `features/triggers/` or `mcp/`). Nothing else changes:
the dispatcher, the filters, the UI picker and the tools read the catalogue.

### 3.4 Tables (migration `0081`, down_revision `0080`)

`trigger_events` and `triggers` as in CONTRACTS §1.3, plus on `triggers`:
`recent_fires` (ISO times of the last hour: the rate limit), `dropped_count`,
`last_dropped_at`, `last_drop_reason`, `pending_count`. A check constraint keeps exactly
one owner. (The repo's revision ids are numbers: the file is `0081_event_triggers.py`,
revision `"0081"`.)

## 4. Dispatch and the rails (`features/triggers/dispatch.py`)

`dispatch()` is the `triggers.dispatch` job (queued by each transaction that emitted)
and a 30-second sweep in the scheduler (so nothing is lost if a job is): it takes
pending events with `FOR UPDATE SKIP LOCKED` (two dispatchers never take one event),
marks them dispatched, and for each enabled trigger of the type:

1. **Expiry; addressing.** Not after `expires_at`. A webhook event matches only the
   trigger it was sent to.
2. **Filter** (`matching.matches`): every field must match; a list means any of; strings
   case-insensitively; a list in the data (`tags`, `fields`) matches when it has one of
   the values. Unknown fields are refused when the trigger is saved.
3. **Loop protection** (§4.4).
4. **The owner**: an automation that is off fires nothing.
5. **Debounce**: with `debounce_s > 0` the firing waits until the window after the first
   event closes, then carries the newest event and how many there were (`coalesced`).
   A job is queued for the window's end; the sweep is the fallback.
6. **No overlapping runs**: while the automation's run works (or the chat answers), the
   firing waits (`pending_since`, the newest event, the count) and goes out once it
   ends, as one firing however many events came in.
7. **Limits**: the trigger's `max_per_hour` (default 12, at most 120) and the global
   ceiling `AutomationSettings.max_trigger_firings_per_hour` (default 60). A firing over
   either is dropped; the trigger counts it and keeps the reason.
8. **Pause all**: events taken while paused are dropped (as schedules skip what came due
   while paused: no catch-up storm afterwards).

A firing that started sets `fire_count`, `last_fired_at`, `last_event_id`; `once`
switches the trigger off. Expired triggers are pruned a day later, events after 7 days
(`service.prune_if_due`, at most every 10 minutes).

### 4.1 An automation run from an event

`run.options["automation"]["trigger"] = "event"` and `run.options["event"] = {id, type,
subject, at, coalesced, depth, trigger_id, summary}`. The run's turn context gets
"## The event that started this run" with the payload (read from the outbox row) inside
`<untrusted_data source="event <type>">`. A retry of a failed event run carries the same
event. The run log entry has `event: {type, summary, at, coalesced}`.

### 4.2 Wake me

The firing calls `conversations.send_event_turn`: a user-role message whose only content
is an `EventRef` block (`providers/base.py`: `{type: "event", event_id, event_type,
trigger_id, at, coalesced, summary, note, data}`, `text_plain` empty), and an agent run
with `options["event"]`. `runtime/history.py` renders the block as text that says the
system added it ("This message is not from the user…"), the trigger's note and the
payload each in an untrusted-data block. Providers never see the block (it is resolved
like a page or an attachment), so no provider changed. `MessageOut.event` tells the app
to show an event card. The chat's answers to it are left out of memory extraction (as
answers to an attached page are), and compaction names it as an event. The run's
`request` is the fixed text `(event) <type>`, never the event's summary: the summary
quotes titles, paths and URIs from outside or from a model, and the request reaches the
model outside an untrusted-data block (compaction shows it as "The user's current
request"). The summary is only shown to the user (the event card, the run log).

### 4.3 Why a trigger is its own row

A trigger could have been a field of an automation. A row of its own lets one automation
have several triggers (and a schedule), lets a chat own triggers without an automation,
keeps per-trigger state (debounce window, rate limit, counts) out of `automations`, and
gives M a place to add its own types without touching automations.

### 4.4 Loop protection

- An event whose `actor_ref` is `automation:<id>/…` never fires that automation's
  triggers; one whose actor is `chat:<id>` never wakes that chat. Approvals and
  automation failures are emitted as the run's own actor, so a run never wakes itself
  through them either.
- **Depth**: the worker runs each run inside `caused_at_depth(d)`, where `d` is one more
  than the depth of the event that started it (or its top run's, for a sub-agent); every
  event it causes carries that depth. Events at depth 3 or more fire nothing (counted on
  the trigger as dropped, "too deep"). With the per-trigger and global limits, that caps
  any chain.
- Runs started by a trigger (and by a schedule) are not offered `create_trigger`,
  `update_trigger`, `delete_trigger`, `create_schedule`, `update_schedule` or
  `delete_schedule` (`registry.toolset_for(event_started=…)`).

## 5. Tools (`tools/builtin/triggers.py`, `schedules.py`)

| Tool | What | Permission |
| --- | --- | --- |
| `create_trigger` | `target: "this_chat"` (wake me) or `"automation"` (an existing automation, by id or name); `event`, `filter`, `debounce_s`, `max_per_hour`, `once` (default true for this chat), `expires_at` (local time; this chat: default 24 h, at most 30 days), `note` | this chat: `triggers.wake`, **safe** for a one-shot one on an internal event that waits ≤ 24 h, else moderate; an automation: `triggers.manage`, dangerous, **always asks** |
| `list_triggers` | the automations' triggers and this chat's (other chats' only counted) | `automation.read` (allowed) |
| `update_trigger` | change one; a wake-me only from its own chat | switching off or the note: follows the level (moderate); anything else on an automation's trigger always asks |
| `delete_trigger` | remove one | this chat's: safe; an automation's: moderate |
| `create_schedule` / `update_schedule` | a `triggers` list (the same fields); a schedule with only triggers gets `{"kind": "manual"}`; `update_schedule`'s list replaces the automation's event triggers (a webhook stays) | as before: always asks, the triggers are in the approval text |
| `list_schedules` | each automation's triggers | |

Why this shape: wake-me is the common case in a chat and needs no automation, so it is
`create_trigger` with `target: "this_chat"`, cheap to approve. A new automation that runs
on events is proposed with `create_schedule` + `triggers`, so the user confirms the
prompt, the settings and the events in one approval card, as the contract asks. Adding
a trigger to an existing automation is `create_trigger` with `target: "automation"`,
asked every time like a changed schedule. The tool's capability is `triggers.wake` (the
common case decides whether it is offered); an automation target is checked against
`triggers.manage`.

**A webhook's secret never goes through the model**: a webhook made by a tool gets a
secret, but the tool tells the model only the URL; the user gets the secret on the
Automations page with **New secret** (password asked). A webhook can't wake a chat.

`FEATURE_TOOLS["automations"]` lists the trigger tools: when the Automations page is off,
they go.

## 6. Webhooks (`webhooks.py`, `hooks_router.py`)

`POST /api/hooks/{trigger_id}`, mounted outside `protected` (no session needed; the
Origin check lets requests without an Origin through). Accepted (`202 {"accepted":
true}`) only when the trigger exists, is a webhook, is on, and its automation is on; the
`X-Anemo-Timestamp` header (Unix seconds) is within 5 minutes; `X-Anemo-Signature:
sha256=<hex>` is the HMAC-SHA256 with the trigger's secret of **`<timestamp>.<raw body>`**
(compared in constant time); the signature wasn't seen in the last 10 minutes (Valkey
`SET NX`); the body is at most 64 KB (refused with 413 from the `Content-Length` or as
soon as the stream passes it). Everything a caller without the secret can try (unknown
or malformed id, off, wrong or missing signature, old timestamp, a replay, a changed
body) gets the same 404. A caller with the secret is rate-limited to 30 accepted
requests a minute per trigger (429). The replay check comes before the rate check (a
replay doesn't use up the sender's rate), and a request refused with 429 is unmarked
again, so the sender's retry of the same signed request is taken, not refused as a
replay.

Failed attempts are limited too: every 404 above counts, in Valkey for a minute, per
client address (20) and per trigger id, known or not (60). Past either limit every
request to it gets the same 404 at once, before the database lookup and the secret's
decryption that each failed attempt would otherwise cost; nothing in the answer tells
the limit apart from any other failure, or an unknown id from a known one. The cost:
someone who knows a webhook's URL can keep it refusing its real sender for as long as
they keep failing at it (the sender's retries get in once they stop). The address is
`request.client`, which uvicorn takes from `X-Forwarded-For` only for
`TRUSTED_PROXIES`; behind an untrusted proxy all callers share one address, so they
share its limit. Without Valkey there is no limit.

Deviation from the contract's wording: the contract says "an HMAC of the raw body" and
"a timestamp header within 5 minutes". Signing the body alone would let anyone who saw
one request replay it later with a fresh timestamp, so the timestamp is signed with it
(as Stripe and Slack do). Without Valkey the replay check is skipped (logged) and only
the 5-minute window protects.

The secret is `whsec_` + 32 random bytes (URL-safe base64), stored in `secrets`
(kind `webhook`), shown once in the creating response and in `POST
/api/triggers/{id}/secret` (rotate, recent password), never listed.

## 7. API (`features/triggers/router.py`)

| | |
| --- | --- |
| `GET /api/triggers?automation_id=&conversation_id=&kind=automation\|wake` | `TriggerOut[]` |
| `POST /api/triggers` | `TriggerIn` (an automation's trigger) → `201 {trigger, secret}` |
| `PATCH /api/triggers/{id}` | `TriggerPatch` → `TriggerOut` |
| `DELETE /api/triggers/{id}` | 204 (its secret too) |
| `POST /api/triggers/{id}/secret` | recent password → `{secret, webhook_url}` |
| `GET /api/triggers/catalogue` | `EventTypeOut[]`: `{type, label, description, fields: [{name, label, kind, choices}]}` |
| `AutomationRunOut.event` | `{type, summary, at, coalesced} \| null` |
| `MessageOut.event` | `{event_type, summary, at, coalesced, trigger_id} \| null` |

`TriggerOut`: `id, automation_id, conversation_id, conversation_title, kind, event_type,
event_label, filter, once, expires_at, debounce_s, max_per_hour, enabled, note,
created_by, fire_count, last_fired_at, dropped_count, last_drop_reason, waiting,
webhook_url, has_secret, created_at`. Every change is in the audit log.

## 8. UI

- **Automations page**, each automation's card: "Also runs when" lists its triggers
  (event, filter, burst window, once, until, fired, dropped with the reason on hover);
  **Add a trigger** / a click on one opens the trigger dialog: the event picker (from the
  catalogue), one field per filterable field (commas for several values, empty for
  any), the burst window, the hourly limit, once, until, on, note; for a webhook its URL,
  how to sign, and **New secret** (shown once). An automation can now run "Only on events
  (or when started)".
- **Chats waiting for an event**: the wake-me triggers that wait, with their chat, the
  event, until when and the note; **Stop waiting** deletes one.
- **Run log**: a run an event started shows the event's summary (and how many were
  coalesced).
- **Chat**: the wake-me turn is an event card in the middle ("An event woke this chat",
  what it was, when), never a bubble of the user's. A chat open at the moment reloads its
  messages when a run starts that it didn't start.
- Translations in `locales/{uk,ru}/automations.ts` and `chat.ts`; the catalogue's labels
  are marked for translation in `features/automations/eventLabels.ts`.

## 9. Security

- Event data is untrusted: it reaches a model only inside `untrusted()`, in the turn
  context or the event turn, never in a system prompt or a tool description. The
  trigger's note (written by an agent) is marked as data too.
- Contact and outward tools still ask in event-started automation runs (the automation's
  `contacts_allowed` rule is unchanged); a wake-me turn is a normal chat run, with the
  chat's permissions.
- Creating an automation trigger or a webhook, or changing what or when one fires, asks
  every time whatever the level (`always_ask`).
- Webhook: §6. `/api/hooks/*` is the only path that has to be reachable from outside
  (`docs/deployment.md`).

## 10. Limits and what is left

- **Plugins**: a plugin's declared automations can't declare triggers yet. It would need
  a `triggers` field on the manifest's `AutomationItem`, the registry's sync to create,
  change and remove the rows on install, update and uninstall, and a version of the
  plugin contract (spec 12) that the review screen shows; none of that is this
  workstream's to change (CONTRACTS-round4 §9), and nothing here rules it out: a
  plugin's automation is an ordinary automation, so its triggers would be ordinary rows
  with every rail above. A line is in the roadmap's *Plugins, after version 1*.
- **Scripts** can have triggers (the rows and the dispatcher don't care), but the Scripts
  tab has no trigger list yet; they are added through the API or `create_trigger`.
- A device whose connection only timed out sends no `device.offline`.
- Bulk SQL statements on tasks, events, documents or code jobs make no events.
- Firings wait for a busy run with at most 30 s of delay (the sweep).
- MCP notifications as a source: workstream M (§3.3).
- Not tested here: the Docker e2e run (CI runs `e2e/tests/triggers.spec.ts`).

## 11. Tests

- `tests/unit/test_trigger_matching.py`: the catalogue, filters (validation, any-of,
  case, tags), loop protection and depth, the rate-limit window, cutting data, the HMAC,
  the untrusted rendering.
- `tests/api/test_triggers.py`: events from task writes (one job per transaction,
  nothing stored without a trigger, only if the change commits), an event starting an
  automation run with its rails (tool list, context, run log), off and paused, its own
  runs and depth, depth passed on by a run, debounce, no overlap with one follow-up,
  per-trigger and global limits, once and expiry and prune, a retry carrying its event,
  a caller's database error not hidden by `emit`, CRUD and validation.
- `tests/api/test_trigger_tools.py`: a code job reaching `done` wakes the chat that asked
  (once; the event card; untrusted; no trigger tools in that run), a chat never woken by
  its own runs and waiting while busy, the wake-me risk levels, no webhook for a chat,
  `create_schedule` with triggers confirmed in one step and `update_schedule` replacing
  them, the run's request being fixed text, automation triggers always asking and switching off following the level,
  trigger-started runs without the write tools, devices online/offline, `file.created`,
  `approval.waiting` and `automation.run_failed`, calendar events, documents, a single
  dispatch for concurrent dispatchers.
- `tests/api/test_webhooks.py`: a signed request starts the run with its body as data;
  the same 404 for everything else (bad or missing signature, old timestamp, unknown or
  malformed id, a changed body, a replay, off); 413 and 429; a request refused with 429
  taken when sent again; failed attempts limited per address and per trigger id with
  the same 404 and no lookup; rotating needs the password and retires the old secret;
  no secret in listings.
- Frontend: `AutomationsPage.test.tsx` (triggers on the card, remove asks, chats waiting,
  the run's event), `TriggerDialog.test.tsx`, `triggerForm.test.ts`, `EventCard.test.tsx`.
- e2e: `e2e/tests/triggers.spec.ts` (add a trigger in the UI, a task fires it, the run
  log shows the event).
