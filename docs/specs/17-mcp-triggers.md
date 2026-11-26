# MCP triggers: a server's notifications fire event triggers

Workstream M of round 4 (`docs/specs/CONTRACTS-round4.md` §1.2, §9, §10). It builds on
event triggers (spec 16): a new event type, `mcp.notification`, whose source is a small
listener in the worker that keeps a session open with each MCP server a trigger names.
Everything after the event (matching, burst windows, limits, loop protection, automation
runs, wake me, the untrusted rendering) is spec 16's, unchanged.

## 1. What was built

| Piece | Where |
| --- | --- |
| The event type, its fields (`server_id` required, `method`, `uri`), its summary | `features/triggers/catalogue.py`, `matching.py`, `render.py` |
| A long-lived session that passes on a server's notifications | `app/mcp/listen.py` (`watch()`) |
| Local (stdio) servers: notifications through the MCP host | `mcp-host/hostd/app.py` `POST /listen` |
| The worker's listener: which servers, one worker per server, reconnect, coalescing, the ceiling | `features/triggers/mcp_listener.py`, started in `main_worker.py` |
| The trigger dialog: event *MCP server notification*, a server picker, the resource URI | `frontend/src/features/automations/components/TriggerDialog.tsx`, `triggerForm.ts` |

No migration: the listener's state is in memory and in Valkey (locks, pauses), and what a
trigger shows uses spec 16's columns (`dropped_count`, `last_drop_reason`).

## 2. The event

```
type     mcp.notification
subject  the server's id
actor    external        (depth 0)
data     {server_id, server, method, uri?, params, count}
```

- `server`: the server's name as configured (for the summary and the run). Never its URL,
  headers or environment (they can hold keys).
- `method`: `notifications/resources/updated`, `…/resources/list_changed`,
  `…/tools/list_changed`, `…/prompts/list_changed`, or `notifications/message` (a log
  message, 2025-era servers). The SDK drops notifications of methods it doesn't know (a
  server's own methods) before they reach us, so those can't fire anything.
- `uri`: for `resources/updated`.
- `params`: what the server sent, without `_meta` (protocol bookkeeping). If its compact
  JSON is over 12 KB it becomes `{"cut": true, "json": "<the first 6 KB>"}`, so the whole
  event stays under spec 16's 16 KB.
- `count`: how many identical notifications were coalesced into this one (§4).

Summary (run log, event card): "MCP server notification: Notes resources/updated note://a".

## 3. Filters

`server_id` (kind `mcp_server`: the dialog shows a picker), `method` (enum), `uri`. On top
of spec 16's matching: equality, a list means any of, strings case-insensitively.

- **The server is required** (`EventField.required`, checked by `matching.check_filter`
  when a trigger is saved, by the API and by the tools alike). A trigger without it would
  fire on every server's notifications; requiring it means a server can only ever fire the
  triggers that name it (the brief's rule), and it tells the listener which servers to
  listen to.
- **URIs are exact, not prefixes.** Spec 16's filters are equality only, and a prefix match
  would need the matcher to know field kinds (`matches(filter, data)` doesn't get the event
  type). Exact also fits how subscriptions work: `resources/subscribe` and a listen stream
  name exact URIs (a 2026-07-28 server may report a sub-resource of one; that URI then has
  to be named too to match). Several URIs: commas in the field (any of). Note that the
  comparison is case-insensitive like every text field of spec 16.
- **No URI** on a `resources/updated` trigger: it matches the updates of the URIs other
  triggers subscribed to on that server (a server only reports subscribed resources).

## 4. The listener (`features/triggers/mcp_listener.py`)

Every 15 seconds (`reconcile()`):

1. **Which servers** (`needs()`): the enabled servers (not a stopped plugin's) that an
   enabled, unexpired trigger on `mcp.notification` names, whose automation is on (a
   wake-me counts). None while "Pause all" is on. For each: the URIs to subscribe (from
   triggers whose method is `resources/updated` or any) and whether log messages are
   wanted (a trigger names `notifications/message`).
2. **One worker per server**: a Valkey lock `mcp:listen:<server id>` = the worker's id,
   60 s expiry, renewed on each pass with a compare-and-expire script. Another worker takes
   over within a minute of one dying; a worker that lost its lock stops its session.
   Valkey rather than Postgres: a Postgres advisory lock lasts as long as one connection,
   and holding a pool connection per server for hours is worse than a key with expiry.
   Without Valkey nothing is listened to (logged), as the worker can't make sure only one
   listens.
3. **Start, keep or stop**: a session starts for a server that needs one, stops when no
   trigger needs it, and restarts when the connection details or the subscriptions change
   (a changed filter alone only replaces the filters used in rail 1 below).

Each session (`ServerWatch`) runs `listen.watch()` and reconnects when it ends, waiting
2, 5, 15, 30, 60, 120, then 300 s between attempts (from the start again after a
connection that lasted two minutes).

What arrives goes through three rails before it is emitted (`events.emit_now`, its own
transaction):

1. **Only what a trigger could match**: the notification (`server_id`, `method`, `uri`) is
   checked against the filters of the triggers that name this server. A chatty server's
   other notifications never reach the outbox.
2. **Coalescing**: the same method and URI again within 5 s joins the first; one event goes
   out at the end of the window with the newest params and `count`. Spec 16's per-trigger
   burst window and hourly limit apply on top.
3. **The ceiling**: more than 120 notifications (all of them, not only wanted ones) in a
   minute, and the server is not listened to for 15 minutes (`mcp:listen:paused:<id>`);
   what waited in the coalescing window is dropped, and each trigger naming the server gets
   `dropped_count + 1` and the reason ("MCP server “X” sent more than 120 notifications a
   minute: not listened to until 14:05 UTC"), which the Automations page shows.

**Defaults for this type, and why.** Servers can be chatty (an editor's resource changes
with every keystroke). The listener's 5-second coalescing folds the burst of one change;
the dialog proposes a 30-second burst window for a new MCP trigger (so a run starts once a
burst of changes is over, with the newest), and spec 16's default of 12 firings an hour
stays. The 120-a-minute ceiling is well above what a server sends for real changes and far
below what would load the worker. The backend's API and tool keep spec 16's default burst
window (0) so as not to change T's shared code; the tool's agent can set one.

## 5. The session (`app/mcp/listen.py`)

`watch(target, wants, deliver, ready)` connects and listens until the connection fails
(`McpError` with the reason) or it is cancelled. The protocol has two eras, and the
server picks (the SDK's `mode="auto"` probes):

- **2025-era servers** (the initialize handshake): notifications come on the session. A
  resource is subscribed with `resources/subscribe` when the server offers it; log
  messages are turned on with `logging/setLevel` when a trigger wants them. A ping every
  30 s notices a dead connection.
- **2026-07-28 servers**: change notifications come only on a `subscriptions/listen`
  stream that names what the client wants (the list changes the server offers, the
  URIs). The stream ending without the server's close (`SubscriptionLost`) is the dead
  connection (that era has no ping). Log messages go only to requests that ask, so an
  idle listener gets none; such a trigger only fires on 2025-era servers.

In both the SDK's message handler sees every notification (the listen stream tees them
there too), so that is the one place they are read. A server that doesn't offer resource
subscriptions is still listened to (list changes), and the log says why the URIs aren't.

Local servers run in the MCP host. hostd already kept one process and session per server;
`POST /listen` (new) adds to that session a buffer of the last 200 notifications and the
subscriptions above (the same logic, copied: the container can't import the backend), and
answers a long poll: `{server, uris, logging, epoch, after, wait_s ≤ 30}` →
`{epoch, next, notifications: [{seq, method, params}], missed, era, subscribed, note}`.
`epoch` changes when the process was started again. A call whose `epoch` isn't the
current one (a new watch: the first call after a reconnect or a lock take-over, or a
process started again) is answered at once with the current `next` and no notifications:
a watch starts from now. Handing over the buffer instead would replay up to 200 old
notifications, some from before the trigger existed, as new events on every reconnect,
and could trip the ceiling. Tool
calls and the listener share the process, and the long poll keeps it from being stopped
as idle.

## 6. Security

- A server's notifications are untrusted text, like its tool results: the event's actor is
  `external`, its params are cut, and spec 16 gives event data to a model only inside
  `untrusted()` (the run's context, the wake-me turn), never in a system prompt or a tool
  description.
- A server can't fire triggers it isn't named in (§3), and nothing it sends changes which
  servers are listened to or what is subscribed (that comes from the triggers alone).
- No secrets in the event: the server's URL, headers and environment stay out.
- A wake-me on `mcp.notification` is `moderate` (asks unless the level allows), like one on
  a webhook: the catalogue marks both as `outside`.
- Loops through a server (a run calls a server's tool, which notifies, which fires the
  trigger again) can't be detected: the notification is "external" whatever caused it. The
  hourly limits and the ceiling cap such a loop.
- Listening to a server that is on is not a new capability: it is the same server agents
  already use; adding a trigger is `triggers.manage` (asks every time) as for any trigger.

`docs/security.md` (*What isolates agents*, MCP row) says the same in short.

## 7. Limits and what is left

- **Custom notification methods** (a server's own `notifications/x`): the MCP SDK drops
  methods it doesn't know unless a client extension binds them. Binding the methods the
  triggers name would be possible (the listener knows them), but no server we know of
  needs it; it is left out.
- **URI prefixes**: exact only (§3).
- **Log messages from 2026-07-28 servers**: none (that era sends them only to requests).
- **The listener's state is not shown on Settings → MCP** (connected, subscribed, paused):
  only a pause shows, on the triggers. A status line per server would need the worker to
  publish it (as the claude-runner status is) and an API field.
- A connection that hangs without closing on a 2026-07-28 server with nothing to listen
  for is not noticed (nothing could arrive on it anyway).
- Reconnecting misses what a server sent while the connection was down (MCP has no replay);
  for a local server too, hostd's buffer is not handed to a new watch (§5).
- The hostd part is tested in-process (the real hostd app, a real stdio server); not tested
  here: the Docker container itself (CI's e2e stack doesn't start the MCP host).
- e2e: `e2e/tests/mcp-triggers.spec.ts` adds an MCP trigger in the dialog; the e2e stack has
  no MCP server that notifies, so the firing is covered by the backend tests only.

## 8. Tests

- `tests/unit/test_mcp_triggers.py`: the type and its required server, the summary,
  notifications without `_meta` (progress and transport errors skipped), cutting params,
  only wanted notifications, what changes a session's key.
- `tests/api/test_mcp_triggers.py`, with real MCP servers (`tests/mcp_server.py`): a
  2026-07-28 session subscribes and passes on only subscribed updates and list changes and
  stays up; a 2025-era session uses `resources/subscribe` and the log level; a dropped
  connection (both eras) and an unreachable server end with `McpError`; the listener listens
  only while an enabled trigger names an enabled server (automation off, server off, trigger
  off, Pause all); one worker per server (the lock, its expiry, take-over, a lost lock); a
  matching notification fires the automation with the event's shape (subject, actor,
  coalesced count) while others store nothing; a server fires only the triggers that name
  it; a trigger must name its server, and the catalogue says so; params cut; reconnect with
  backoff, and to a server that came back; a chatty server is paused and its triggers say
  why, and is listened to again after the pause; a wake-me on it is moderate; a local server
  listened to through the real hostd (`/listen`), sharing the process with tool calls; a new
  watch through hostd starts from now (no backlog); hostd wants its token.
- Frontend: `TriggerDialog.mcp.test.tsx` (the server picker, required, the URI, the 30 s
  default; the form rules).
- e2e: `e2e/tests/mcp-triggers.spec.ts`.
