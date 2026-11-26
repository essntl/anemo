# Code: live view of Claude Code jobs

Status: phase 1 (watch) and phase 2 (control). This file is the contract between the
desktop client, the backend and the frontend for this feature. The wire part is also in
`docs/device-contracts.md` §7; when the two disagree, `device-contracts.md` wins and this
file is fixed.

## 1. Goal

Agents in Anemo start **Claude Code jobs** (headless `claude -p` runs) on a computer that
runs Anemo Desktop. Until now nobody saw them except the agent polling the job folder.
The **Code** page shows every job on every computer live: what it does, its tool calls,
its todo list, its result, its API-equivalent cost, its branch and pull request. A
notification says when a job finishes or fails. Phase 2 adds cancelling, follow-ups,
starting a job from the page, and agent tools that replace the PowerShell bridge
(`C:\anemo-bridge\cc.ps1`).

Claude Code is treated as an **independent agent whose activity Anemo shows**, not as a
model inside Anemo's agent loop. The `claude_code` provider (`providers/adapters/
claude_code.py`, `claude-runner/`) is unrelated and is not used.

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | Anemo Desktop owns the jobs of its computer: it discovers and tails job folders (phase 1) and starts and cancels jobs (phase 2). | It already has an authenticated, reconnecting channel to the server and runs on the machine. |
| D2 | The job folder format of `cc.ps1` is kept as is (`<jobs>\<id>\prompt.txt, out.jsonl, err.txt, meta.json, cancelled`). Desktop only reads it in phase 1, and writes the same format in phase 2. | Jobs started by either side show up. |
| D3 | Events travel over the existing device WebSocket as new message types `code.job`, `code.events` (client → server) and `code.ack` (server → client). | No second connection, no new token. |
| D4 | Sharing is opt-in on the computer ("Share Claude Code jobs with Anemo", off by default) **and** the device must be *trusted* in Anemo. The client checks both; the server ignores `code.*` frames from a device that is not trusted (no ack, nothing stored). | A job's log can contain anything the job read, secrets included. |
| D5 | The server is the source of truth for how far a job was received: every `code.job` is answered with a `code.ack` giving the last contiguous `seq` stored, and the client resends from there. The client's persisted ack is only a fallback. | A reconnect, a restored database or a lost frame all heal the same way. |
| D6 | `seq` is the 1-based number of the **non-blank** line in `out.jsonl`. Lines that are not JSON objects are sent as `{"type": "raw", "text": …}`, so the numbering has no holes. | Contiguity can be checked with a single integer. |
| D7 | Both sides trim events with the same algorithm (§6); the server's result is the one stored. The full log always stays on the computer. | The client keeps frames small; the server can't trust the client. |
| D8 | Follow-ups are chained by `resume_session`: a job whose `resume_session` is the `session_id` of an earlier job of the same device belongs to that job's **thread**. The list shows one row per thread; the detail page shows the whole thread with a separator per job. | Matches how `claude --resume` works, whether or not Claude Code keeps the session id. |
| D9 | Live updates: a per-job Redis stream `code:{job_id}` (SSE `GET /api/code/jobs/{id}/stream`) carries the job's new events; the global stream carries a small `code.job` notice (throttled) so lists refresh. | The global stream keeps 1000 entries; a job can write thousands of events. |
| D10 | A notification ("agent" kind) is sent when a job the server saw *running* becomes `done`, `failed` or `exited_without_result`. Jobs first seen already finished (back-fill) and cancelled jobs don't notify. | Turning sharing on must not flood the inbox; a cancel is the user's own doing. |
| D11 | Deleting a device deletes its jobs (foreign key cascade). | Same as its token. |
| D12 | The branch is taken from the events (`git checkout -b`, `git switch -c`, `git push -u <remote> <branch>`, "Switched to a new branch '…'") and otherwise from the client, which reads `<dir>\.git\HEAD` when it sends `code.job`. Events win. | Free, needs no process on the computer. |
| D13 | `total_cost_usd` is shown as **API-equivalent cost**, never as money spent. | Artem uses a Claude subscription. |
| D14 | Phase 2 commands are `device.command` actions (`code_projects`, `code_start`, `code_cancel`) and need a second desktop setting, "Let Anemo start Claude Code jobs" (off by default), advertised in `device.offer`. | Starting a job with `bypassPermissions` is as strong as PowerShell; it gets its own switch. |
| D15 | Images with a prompt are files in the job's folder whose paths the prompt lists (§13), not `--input-format stream-json` image blocks. | Works for a new job and `--resume` alike with the `claude -p` command line, `prompt.txt` and the folder format unchanged; easy to port. |

## 3. Protocol (phase 1)

Exact shapes are in `docs/device-contracts.md` §7. Summary:

```
client → {"type": "device.offer", "control": bool, "shell": bool, "code": bool}
          code: "Share Claude Code jobs with Anemo" is on (and the client is trusted)
client → {"type": "code.job", "job": {
            "id": "20261123-101500-ab12",           // the folder name, ^\d{8}-\d{6}-[A-Za-z0-9]{4}$
            "device_job_dir": "C:\\anemo-bridge\\jobs\\20261123-101500-ab12",
            "project": "anemo",                     // last segment of dir
            "dir": "C:\\dev\\anemo",
            "started": "2026-11-23T10:15:00+01:00", // ISO 8601 with offset
            "prompt": "…",                          // prompt.txt, ≤ 20 000 characters
            "resume_session": "…" | null,
            "model": "opus" | null,                 // from meta.json when present, else null
            "pid": 1234 | null,
            "state": "running" | "done" | "failed" | "cancelled" | "exited_without_result",
            "ended": "…" | null,                    // when the client saw it end
            "branch": "feat/x" | null,              // from <dir>\.git\HEAD
            "stderr_tail": "…" | null}}             // last ≤ 4000 characters of err.txt, once ended
server → {"type": "code.ack", "job_id": "20261123-101500-ab12", "seq": 0}
client → {"type": "code.events", "job_id": "20261123-101500-ab12",
          "events": [{"seq": 1, "event": {…}, "trimmed": false}, …]}
server → {"type": "code.ack", "job_id": "…", "seq": 57}
```

Rules:

- `code.job` is sent when a job is discovered, on every change of `state`, `branch` or
  `pid`, and once per job after each (re)connect for every job that is not *settled*
  (settled = terminal state sent and acked up to the end of `out.jsonl`).
- The server answers every `code.job` with `code.ack` (its last contiguous `seq`,
  0 when none). The client sends events only after that first ack, from `seq + 1`.
- One `code.events` frame in flight per job: the next one waits for the ack of the
  previous one. A frame holds at most **200 events** and at most **256 KB** of UTF-8.
- When a job ends, the client sends the remaining events first and the `code.job` with
  the terminal state after them.
- The server acks the highest `seq` such that every seq from 1 to it is stored. Frames
  may repeat (dedupe on `(job, seq)`) or arrive out of order; a gap holds the ack back
  until it is filled.
- Frames over the size limits, with a malformed job id, or from a device that is not
  trusted are ignored (no ack). `code.events` for a job the server has no row for is
  ignored (the client always sends `code.job` first).
- Server limits on the text of a frame: `code.job` ≤ 64 000 characters, `code.events`
  ≤ 300 000 characters; all other messages keep the 4096 limit.

### Phase 2 additions

```
client → {"type": "device.offer", …, "code": bool, "code_start": bool}
server → {"type": "device.command", "id", "action": "code_projects"}
         → state {"projects": [{"name", "dir", "remote": "https://github.com/…" | null}],
                  "remote": [{"name", "url"}], "note": "…" | null}
server → {"type": "device.command", "id", "action": "code_start", "project": "anemo",
          "prompt": "…", "new": false, "resume_session": null, "model": null, "max_turns": null}
         → state {"job_id": "20261123-101500-ab12", "dir": "C:\\dev\\anemo", "project": "anemo"}
server → {"type": "device.command", "id", "action": "code_cancel", "job_id": "…"}
         → state {"job_id": "…", "state": "cancelled"}
```

`code_start` with `resume_session` is a follow-up. Refused (`code: "refused"`) when the
device isn't trusted or "Let Anemo start Claude Code jobs" is off; `failed` with a
sentence when the project can't be resolved or `claude` isn't found.

## 4. Desktop client

Folder: `Anemo.Desktop.Core/CodeJobs/` (no Windows APIs; process checks go through a
small interface implemented in `Anemo.Desktop/Platform/`).

- **Settings** (`DesktopSettings`): `ShareCodeJobs` (bool, false), `CodeJobsFolder`
  (string?, null = `C:\anemo-bridge\jobs`); phase 2: `StartCodeJobs` (bool, false),
  `CodeProjectsFolder` (string?, null = `C:\dev`), `GitHubOwner` (string?, null =
  `essntl`). Shown in the Settings window with a sentence on what is shared.
- **Discovery**: every 2 s while connected, trusted and sharing is on, list the jobs
  folder. A subfolder counts when its name matches the id pattern and `meta.json` reads.
  On the first scan after sharing is switched on, only jobs started in the last **3
  days** are taken (back-fill); later, every new folder.
- **meta.json**: `{id, pid, dir, resume, started, prompt_preview}` plus optional `model`;
  unknown fields are ignored; `prompt.txt` is the prompt (`prompt_preview` if missing).
- **Tailing**: read `out.jsonl` from the byte offset after the last sent line; only
  complete lines (ending in `\n`); blank lines are skipped and don't count; a line that
  doesn't parse as a JSON object becomes `{"type": "raw", "text": <line, ≤ 2000 chars>}`.
  Files are opened with `FileShare.ReadWrite | FileShare.Delete`.
- **State**: `cancelled` marker → `cancelled`; a `result` event → `failed` when
  `is_error` is true or `subtype` isn't `success`, else `done`; else the process is
  alive → `running`; else (the process is gone, the file read to its end once more,
  still no result) → `exited_without_result`. "Alive": a process with that pid exists
  and started no later than one minute after `meta.started` (guards against pid reuse). A process whose state or start time can't be read (another user's, or elevated) counts as alive only while `out.jsonl` or `err.txt` was written in the last 30 minutes.
- **Persisted state**: `%APPDATA%\Anemo Desktop\code-jobs.json`: `shared_since` (the
  first scan after sharing was switched on; cleared when it is switched off; a "new
  folder" is one started no earlier than `shared_since` minus 3 days, and folders older
  than 14 days are never discovered) and per job `{acked_seq, acked_offset, sent_state,
  settled}`; written after each ack (temp file, then move).
  Jobs older than 14 days are forgotten. A damaged file starts empty (the server's acks
  repair it).
- **Trimming**: §6, before a frame is built; `trimmed: true` on the item.
- **Ordering details**: a job first seen already finished (back-fill, or it ended while
  the client was closed) is announced with its terminal state, then its events, then the
  terminal `code.job` again, so it is never announced as running (D10). At most 4 jobs
  have a frame in flight at once, running jobs first. `ended` is the last-write time of
  `cancelled` or `out.jsonl`; `stderr_tail` is sent only with a terminal state; the
  branch is frozen once a job has ended. An unterminated last line of a dead job is
  never sent.
- **A server that never acks** (an Anemo without the Code page): when no `code.ack` came
  on a connection within 60 s of the first `code.job`, the client stops sharing on that
  connection instead of reconnecting; once one ack has come, 60 s of silence
  reconnects.
- Logs (`DiagnosticLog`) say "code job discovered/ended" with the job id only, never
  contents.

## 5. Backend

`backend/app/features/code_sessions/` (`models.py`, `ingest.py` (the WebSocket side),
`service.py`, `router.py`, `schemas.py`, `trim.py`, `parse.py` (pull-outs: session,
todos, PR, branch)).

### 5.1 Tables

`code_jobs` (IdMixin, TimestampMixin):

| column | type | |
|---|---|---|
| device_id | uuid FK devices ON DELETE CASCADE | |
| job_key | varchar(40) | the device's job id; unique with device_id |
| job_dir | varchar(1000) | `device_job_dir` |
| project | varchar(200) | |
| dir | varchar(1000) | |
| title | varchar(200) | first non-blank line of the prompt, ≤ 120 characters |
| prompt | text | ≤ 20 000 characters |
| state | varchar(30) | check: the five states |
| started_at | timestamptz | |
| ended_at | timestamptz null | |
| last_event_at | timestamptz null | when the last events arrived |
| seen_running | bool | the server saw it running (D10) |
| notified_at | timestamptz null | the notification was sent |
| resume_session | varchar(100) null | |
| session_id | varchar(100) null | from `system/init` or `result` |
| thread_id | uuid | the id of the first job of its thread (itself when none) |
| model | varchar(100) null | `system/init` `model` wins over the client's |
| pid | int null | |
| branch | varchar(255) null | D12 |
| branch_from_events | bool | |
| pr_url | varchar(500) null | the last GitHub PR URL seen |
| todos | jsonb | the last TodoWrite list: `[{content, status, activeForm?}]` |
| todos_seq | int | the seq it came from (an older batch doesn't overwrite) |
| pullout_seqs | jsonb | `{session_id, model, pr_url, branch, result}` → the seq each value came from; an older seq never overwrites a newer one (internal, not in the API) |
| num_turns, duration_ms | int null | from `result` |
| cost_usd | numeric(12,6) null | `total_cost_usd` from `result` |
| result_text | text null | `result.result`, ≤ 16 000 characters |
| result_subtype | varchar(60) null | |
| is_error | bool | |
| stderr_tail | text null | ≤ 4000 characters |
| last_seq | int | the last contiguous seq stored (what is acked) |
| event_count | int | |
| stored_bytes | int | sum of stored event sizes |
| truncated | bool | some events were trimmed or dropped |

Indexes: `(device_id, job_key)` unique, `started_at`, `(thread_id)`, `(device_id,
session_id)`, `(project)`.

`code_job_events` (IdMixin, TimestampMixin): `job_id` (FK code_jobs ON DELETE CASCADE),
`seq` int, `kind` varchar(20) (`system` | `assistant` | `user` | `result` | `raw` |
`other`), `event` jsonb, `size` int (UTF-8 bytes of the stored JSON), `trimmed` bool,
`dropped` bool. Unique `(job_id, seq)`. Inserted with `ON CONFLICT DO NOTHING`.

### 5.2 Ingestion

`ws.py` hands `code.job` / `code.events` of a computer to `code_sessions.ingest`; it is
the only devices module that imports code_sessions. `code_sessions.service` reads
`devices.models.Device` and `devices.relay.connected` to show a job's device (no
module cycle). Each frame: validate
with Pydantic (`Field` limits), open a session, do the work, commit, publish, ack.

- **code.job**: upsert by `(device_id, job_key)`. Terminal states are sticky, except
  that `exited_without_result` becomes `done`/`failed` when a `result` event arrives
  later, and `cancelled` from the client always wins. `seen_running` is set when the
  stored state is `running`. Thread: when `resume_session` matches the `session_id` of
  another job of the device, `thread_id` = that job's `thread_id`; when a job's
  `session_id` becomes known, jobs of the device whose `resume_session` equals it and
  that are their own thread move into its thread.
- **code.events**: trim (§6) each event, insert, then: `last_seq` = the highest seq such
  that all of 1..seq exist (recomputed from `last_seq` forward only when needed),
  `event_count`, `stored_bytes`, `last_event_at`, and the pull-outs: session id, model,
  todos (latest `TodoWrite` `input.todos` by seq; pull-outs are read from the event as
  received, before it is trimmed or stubbed), PR URL
  (`https://github\.com/[\w.-]+/[\w.-]+/pull/\d+` in tool results, assistant text and the
  result), branch (D12), and the `result` fields. A `result` event makes the job
  terminal (`done` / `failed`).
- **Over 5 MB** (`stored_bytes`): later events are stored as stubs with `dropped: true`:
  `{"type": <type>}` plus what places the event (the fields step 4 of §6 keeps:
  `parent_tool_use_id`, `tool_use_id`, `status`, the ids of its tool calls and results),
  so the page still files it under its sub-agent (§7.5). Still stored whole (trimmed):
  `result` events, assistant events holding a `TodoWrite` call, and what starts or ends
  a sub-agent (a `Task` / `Agent` call, a tool result with `tool_use_result.agentId`,
  `system/task_started`, `task_notification`, `task_updated`). `truncated` is set.
- **Publishing** (after commit): `code:{job_id}` stream (maxlen 2000, TTL 24 h) gets
  `code.events` `{job_id, events: [CodeEventOut]}` and `code.job` `{job: CodeJobOut}`
  on every change; the global stream gets `code.job` `{job_id, thread_id, state,
  project}` on a state change and otherwise at most every 5 s per job.
- **Notification** (once, `notified_at`): `done` → "Claude Code job finished: <title>"
  (success); `failed` / `exited_without_result` → "Claude Code job failed: <title>"
  (error); body: project, turns, duration, API-equivalent cost; link `/code/<job id>`.
- **Device offline**: when a computer's connection closes, `code.job`
  `{device_id, online: false}` is published on the global stream if it sent code frames.
  Jobs keep their state; the API adds `device.online` and `device.last_seen_at`.
- Logs: ids and counts only.

### 5.3 Retention

Settings section `code` (`CodeSettings`): `keep_days: int = 30` (1–365). Scheduler task
`code.prune` (gated to once every 10 minutes): delete jobs whose last activity
(`greatest(started_at, last_event_at, ended_at)`) is older than `keep_days` (events
cascade), except a `running` job of a computer that sent events within `keep_days`. The client never re-announces a settled job, so pruned
jobs don't come back.

### 5.4 HTTP API (all under `protected`)

| method, path | body / query | answer |
|---|---|---|
| `GET /api/code/jobs` | `project?`, `state?`, `device_id?`, `limit` (1–500, 200), `before?` + `before_id?` (`started_at` and `id` of the last row; rows strictly before `(started_at, id)`) | `CodeJobListOut {jobs: CodeJobOut[], projects: string[], has_more}` |
| `GET /api/code/jobs/{id}` | | `CodeJobDetailOut {job: CodeJobOut, thread: CodeJobOut[]}` (thread in start order, includes the job) |
| `GET /api/code/jobs/{id}/events` | `after_seq` (≥ 0, 0), `limit` (1–2000, 500) | `CodeEventsOut {events: CodeEventOut[], last_seq, has_more}` |
| `GET /api/code/jobs/{id}/stream` | `Last-Event-ID` header | SSE: `: connected`, a `code.job` snapshot from the database (no `id:`), then every `code.events` / `code.job` published after the newest stream entry at connect (or after `Last-Event-ID`). It doesn't end by itself; with Valkey down it sends a snapshot every 5 s. The page refetches `events?after_seq=` when a `code.job`'s `last_seq` is past what it holds |

`CodeJobOut`: `id, job_key, device: {id, name, online, last_seen_at}, project, dir,
job_dir, title, prompt, state, started_at, ended_at, last_event_at, session_id,
resume_session, thread_id, model, branch, pr_url, todos, num_turns, duration_ms,
cost_usd, result_text, result_subtype, is_error, stderr_tail, last_seq, event_count,
truncated`. `CodeEventOut`: `seq, kind, event, trimmed, dropped, created_at`.

Phase 2:

| method, path | body | answer |
|---|---|---|
| `GET /api/code/devices` | | `[{id, name, online, share, start}]`: trusted computers and what they offer |
| `GET /api/code/devices/{id}/projects` | | `{projects, remote, note}` (the `code_projects` command) |
| `POST /api/code/jobs` | `{device_id, project, prompt (1–100 000), new: bool, model?, max_turns? (1–500)}` | 201 `CodeJobOut` |
| `POST /api/code/jobs/{id}/follow-up` | `{prompt, model?, max_turns?}` | 201 `CodeJobOut` (the new job, same thread) |
| `POST /api/code/jobs/{id}/cancel` | | `CodeJobOut` |

Starting creates the row at once from the command's answer (state `running`,
`seen_running`), with `conversation_id` / `run_id` when an agent tool started it
(phase 2 columns, FK SET NULL); the client's `code.job` then fills the rest.

## 6. Trimming (both sides)

Applied to one event; `limit` = 16 000 bytes of compact UTF-8 JSON.

0. (Server only) Clean: NUL and lone surrogates become U+FFFD, nesting deeper than 100
   becomes `"[nested too deep]"` (Postgres `jsonb` would reject them). Sizes are measured
   on compact JSON as Python's `json.dumps(ensure_ascii=False, separators=(",", ":"))`
   writes it.
1. Remove known copies: `tool_use_result.originalFile`, `tool_use_result.file.content`
   (Read), and `tool_use_result.content` when `tool_use_result.type` is `create` or
   `update` (Write: the same text is in the `tool_use` input). Removing counts as
   trimming.
2. If over `limit`: cut every string longer than 2000 characters to its first 1500 and
   last 400 characters joined by `"\n… [N characters trimmed] …\n"`.
3. If still over: starting again from step 1's result, cut every string longer than 600
   characters to its first 400 and last 100.
4. If still over: replace the event with `{"type", "subtype"?, "anemo_trimmed": "too
   large"}`, plus what places it: `parent_tool_use_id`, `tool_use_id` and `status` when
   each is a text of at most 200 characters (or a boolean), `message.content[].{type,
   name,id}` of tool calls and `message.content[].{type,tool_use_id,is_error}` of tool
   results (each field only when short, as above). Without these a sub-agent's events
   would move to the main agent's timeline, and its end would be lost (§7.5).

`trimmed` is true when any step changed the event. Phase 1 server limits: 16 000 bytes
per event, 5 MB per job (§5.2).

## 7. Frontend

`frontend/src/features/code/`. Route `/code` (list) and `/code/:jobId` (detail), lazy.
`PAGE_INFO.code` (`/code`, icon `SquareTerminal`, label "Code", `hasTools: true` in phase
2), `PageId` "code" (backend default: under "More"), command palette entry ("Code",
keywords "claude code jobs sessions"). Ukrainian and Russian texts.

### 7.1 Layout

- Wide (≥ `lg`): two panes, list (320 px) on the left, the selected thread on the
  right; `/code` without a job shows "Pick a job".
- Narrow: `/code` is the list, `/code/:jobId` the thread with a back button (mobile
  navigation as in other pages).

### 7.2 List

- Grouped by **project** (header: project name, count), threads under it, newest
  first; projects ordered by their newest job.
- One row per **thread**, showing its latest job: title (of the first job), state
  badge, device, "started 5 min ago", duration (live while running), turns,
  API-equivalent cost (sum over the thread), branch / PR chip when known; a small
  "N follow-ups" when the thread has more than one job.
- Filters: project (select) and state (all / running / done / failed / cancelled /
  exited without result). Kept in the URL query.
- Live: `code.job` on the global stream invalidates the list query.
- States: loading (skeleton rows), empty ("No Claude Code jobs yet" + how to turn
  sharing on in Anemo Desktop on a trusted computer), empty after filters, error.

### 7.3 Detail (a thread)

- Header: title, project, folder, device (with "offline since …" when it is), session
  id (copy), state badge, live timer while running, branch and PR links.
- **Todo list** pinned at the top while the job runs (sticky), collapsible after it
  ends: progress "3 / 7", each item with its status (pending / in progress with
  `activeForm` / completed).
- Timeline, built from the events (`timeline.ts`, pure and tested):
  - `system/init`: a quiet line (model, folder).
  - assistant `text` → `Markdown`; `thinking` → collapsed "Thinking".
  - `tool_use` paired with its `tool_result` (by `tool_use_id`) → a collapsible row:
    Bash (command; output, error in red), Edit / MultiEdit / Write (path; diff from
    `tool_use_result.structuredPatch`, else from `old_string`/`new_string`, else the
    content), Read (path, lines), Grep / Glob (pattern, path), WebFetch / WebSearch (URL
    / query), TodoWrite (the list), Task / Agent (description; its events — those with
    `parent_tool_use_id` = the call's id — nested inside, or, when the thread lists its
    sub-agents (§7.5), a link to the sub-agent's own view), anything else (name, input
    JSON, result text). A call without a result yet shows a spinner while running.
  - `is_error` results highlighted.
  - `raw` → plain text; dropped events collapse into "N events not stored (over
    5 MB). The full log is on the computer: <job_dir>\out.jsonl"; trimmed ones carry a
    "trimmed" mark with the same hint.
  - `result` → result card: the summary as Markdown, turns, duration, API-equivalent
    cost, error subtype when failed; `stderr_tail` shown for `exited_without_result`.
- Thread: jobs in order with a separator ("Follow-up · started …") and each job's
  prompt as the user's message at the top of its part.
- Scrolling: `useStickToBottom` while running; scrolling up stops following.
- Live: the latest running job's SSE stream; on open (and after a gap in seq) the page
  fetches `events?after_seq=<last seq it has>` and merges by seq.
- Everything from a job is untrusted: Markdown or plain text, never raw HTML.

### 7.5 Sub-agents

A job whose main agent starts sub-agents (`Task` / `Agent` calls) gets a list of its
agents, so their work isn't mixed into one timeline (`agents.ts`, pure and tested
against a shortened real job, `agents.fixture.json`).

- **Grouping**: every event a sub-agent writes carries `parent_tool_use_id` = the id of
  the call that started it; a sub-agent's own sub-agents carry *their* call's id (made
  inside the outer one), so the agents form a tree. "Main" holds the events without a
  parent, and those whose parent isn't a known call (its event wasn't stored).
- **State**: a foreground sub-agent ends with its call's `tool_result` (`is_error` →
  failed; `tool_use_result.totalDurationMs`, `totalToolUseCount`). A background one
  (`run_in_background`) gets a `tool_result` at once (`tool_use_result.status:
  "async_launched"`) and ends with `system/task_notification` (`tool_use_id` = the call,
  `status: "completed"` → done, anything else → failed; or `task_updated` with
  `patch.status`). While it runs, `system/task_progress` (same `tool_use_id`) reports
  `usage.duration_ms` and `usage.tool_uses`. Still running when the job ended →
  "stopped". Times come from the events' own `timestamp`, else from `created_at`.
- **Layout**: from `xl` up, a 256 px column right of the thread lists "Main agent" and
  every sub-agent (indented by depth): state icon (a spinner while running),
  description (the call's `description`, else its prompt's first line), `subagent_type`,
  duration (counting up while it runs) and its own tool calls. Below `xl`, a compact
  switcher in the thread's top bar opens the same list (a popup from `md` up, a bottom
  sheet on a phone). No list for a job without sub-agents.
- **Selection**: `?agent=<call id>` in the address (a reload keeps it; links to other
  jobs and to the list drop it). A sub-agent's view shows its description, state and
  prompt (from the call), its own events, and its answer when it was a foreground one.
  In "Main", each Agent call has "Open this sub-agent", and its row shows the
  sub-agent's state instead of a spinner. The follow-up box stays.
- **Live**: the job's events are read from the same queries the timeline keeps live, so a
  new sub-agent or a sub-agent's end shows as its event arrives.
- Branch and pull request stay in the header; the column doesn't repeat them.

### 7.4 Phase 2 controls

Cancel button (running job), follow-up composer at the bottom of a finished thread
(resumes its last session), "New job" dialog (device, project picker fed by
`code_projects` with a "new project" toggle, prompt, model: default / opus / sonnet /
haiku). A job started by an agent shows "From chat: <title>" linking to the chat; the
chat's tool call row for `code_start` / `code_status` shows a chip linking to the job.

## 8. Agent tools (phase 2)

`tools/builtin/code.py`: `code_projects(device)`, `code_start(device, project, prompt,
new?, resume_session?, model?, max_turns?)`, `code_status(job_id)` (state, todos, the
last 8 activities as one-line summaries, the result when done; marked untrusted),
`code_cancel(job_id)`. Capabilities `code.see` (projects, status; default allow) and
`code.run` (start, cancel; default allow on trusted devices; a watched device is
refused, since sharing needs trust). In `FEATURE_TOOLS["code"]`. The tools record
`conversation_id` and `run_id` on the job. Tool descriptions and prompt text tell agents
to use these instead of `computer_shell` with `cc.ps1`.

## 9. Limits

| what | limit |
|---|---|
| event stored | 16 000 bytes (trimmed, §6) |
| job stored | 5 MB of events; then stubs (§5.2) |
| `code.events` frame | 200 events, 256 KB (client); 300 000 characters (server) |
| `code.job` frame | 64 000 characters; prompt 20 000 characters |
| raw line | 2000 characters |
| stderr tail | 4000 characters |
| events per request | 2000 |
| retention | `code.keep_days`, 30 days |
| back-fill | jobs started in the last 3 days |

## 10. Phases

- **Phase 1** (`feat/code-sessions`): §3 (without the phase 2 additions), §4 (sharing),
  §5 (without phase 2 endpoints), §6, §7.1–7.3, the e2e spec with a fake device.
- **Phase 2** (`feat/code-sessions-control`, stacked): §3 phase 2 commands, the start
  setting and job starting/cancelling in Desktop, §5.4 phase 2 endpoints and columns,
  §7.4, §8.

## 11. Open questions (answered)

1. *cc.ps1 and job samples aren't on the machine this was written on.* The format is
   taken from the task description and the stream-json format Claude Code writes
   (verified against local Claude Code transcripts). Unknown fields are ignored on every
   side.
2. *Does `--resume` keep the session id?* Either way works (D8).
3. *Where does the model come from?* `system/init` `model`; `meta.json` `model` if a
   later `cc.ps1` writes it.
4. *What if the user turns sharing off?* The client stops sending; stored jobs stay
   until retention. Running jobs then look like an offline device's.
5. *Old jobs when sharing is first turned on?* The last 3 days, without notifications.
6. *A job keeps running while the computer is off or Desktop closed?* The job's state
   stays as last sent, flagged "offline since"; when Desktop comes back it catches up.
7. *Should jobs be deletable from the page?* Not in this feature; retention removes
   them.
8. *Notification kind?* The existing `agent` kind, so current destination settings
   apply without a migration.

## 12. Phase 2 in detail

Phase 2 is built on `feat/code-sessions-control` (stacked on phase 1). It adds control
on top of §3 (phase 2 additions), §5.4 (phase 2 endpoints), §7.4 and §8; this section
makes those exact.

### 12.1 Desktop (Anemo Desktop 1.2.0)

- Settings: `StartCodeJobs` (bool, false; label "Let Anemo start Claude Code jobs", with
  a sentence that jobs run with `--permission-mode bypassPermissions`, so Anemo's agents
  can run anything Claude Code can), `CodeProjectsFolder` (null = `C:\dev`),
  `GitHubOwner` (null = `essntl`). `StartCodeJobs` only counts while `ShareCodeJobs` is
  on (a job Anemo starts must be visible to it).
- Offer: `"code_start": bool` = start on, share on, trusted.
- `code_projects`: every folder in the projects folder (`name` = folder name, `remote` =
  the `remote "origin"` `url` from `.git/config`, or null); `remote`: the owner's
  repositories from `gh repo list <owner> --limit 200 --json name,url` that no local
  folder has (by folder name or remote repository name); when `gh` is missing or fails,
  `remote: []` and `note` says why in one sentence. Timeout 30 s for `gh`.
- `code_start`, like `cc.ps1`:
  1. Validate: `project` matches `^[A-Za-z0-9._-]{1,100}$` (no path, not `.` or `..`),
     prompt 1–100 000 characters, `model` `^[A-Za-z0-9._\[\]-]{1,100}$`, `max_turns`
     1–500, `resume_session` `^[A-Za-z0-9-]{1,100}$`; else `failed` with a sentence.
  2. Resolve: `<projects>\<project>` if it exists; else a folder whose origin remote's
     repository name is `project`; else clone `<owner>/<project>` (`gh repo clone` when
     `gh` is on PATH, else `git clone https://github.com/<owner>/<project>.git`), 10
     minutes at most; else, with `new`, create `<projects>\<project>` and `git init` it;
     else `failed`: "There is no project "x" in C:\dev or on GitHub (essntl)."
  3. Make the job folder `<jobs>\<id>` (id from the local time + 4 random lowercase
     letters/digits, unique), write `prompt.txt` (UTF-8, no BOM) and `meta.json`
     `{id, pid, dir, resume, started, prompt_preview, model}` (`prompt_preview`: the
     first 200 characters).
  4. Start, detached and windowless, in the project folder: `cmd.exe /d /c claude -p
     --output-format stream-json --verbose --permission-mode bypassPermissions
     [--resume <s>] [--model <m>] [--max-turns <n>] < prompt.txt > out.jsonl 2> err.txt`
     (paths quoted; arguments come only from validated values). Write the pid into
     `meta.json`. `failed` "Claude Code (claude) isn't on this computer's PATH." when
     `where claude` finds nothing.
  5. Answer `{job_id, dir, project}`; the sharing loop discovers the folder on its next
     scan and sends `code.job` as for any job.
- `code_cancel`: the job folder must exist (else `failed` "There is no job x."); if the
  job has ended, answer its state; else kill the process tree of `pid` (with the
  pid-reuse guard), write the `cancelled` file, answer `{job_id, state: "cancelled"}`.
- All three are refused (`refused`) unless trusted and the right setting is on
  (`code_projects`: share; `code_start` / `code_cancel`: start). Commands run like the
  others (one at a time per device).

### 12.2 Backend

- Migration 0074: `code_jobs.conversation_id` (FK conversations, SET NULL) and `run_id`
  (FK runs, SET NULL), both nullable and indexed. Ingestion never overwrites them.
- `relay.Offer` gains `code_start` (stored like `code`).
- `CodeJobOut` gains `conversation_id`, `run_id`, `conversation_title` (null when none);
  `CodeDeviceRef` gains `share`, `start` (from the live offer; false when offline).
- Endpoints (§5.4): `GET /api/code/devices` (trusted computers), `GET
  /api/code/devices/{id}/projects`, `POST /api/code/jobs`, `POST
  /api/code/jobs/{id}/follow-up` (the thread's last job must have ended and have a
  `session_id`; resumes it in the same project on the same device), `POST
  /api/code/jobs/{id}/cancel` (a job that has ended is returned as it is).
- Errors (`AppError` subclasses, stable codes): `device_offline` (409: not connected or
  no fresh offer), `code_start_off` (409: the device doesn't offer `code_start`, or
  `code` for projects), `device_not_trusted` (403), `job_running` (409: a follow-up
  while the thread's last job runs), `no_session` (409: nothing to resume),
  `device_failed` (422: the client answered `failed`; `message` is the client's
  sentence), `device_refused` (403).
- Timeouts for `relay.send`: `code_projects` 45 s, `code_start` 60 s (the desktop answers
  at once and clones afterwards, §12.5; the `code_start` tool's own limit is 90 s),
  `code_cancel` 30 s. A device busy with another command answers `device_busy` (409).
- Starting creates (upserts) the row from the answer: `job_key`, `dir`, `project`,
  `prompt`, `title`, `resume_session`, `model`, state `running`, `seen_running`,
  `started_at` = now, `thread_id` by `resume_session` as usual, plus `conversation_id`
  and `run_id` when an agent tool started it. It publishes like ingestion.
- One service function per action (`start_job`, `follow_up`, `cancel_job`, `projects`,
  `devices`) used by both the router and the tools.

### 12.3 Agent tools (`tools/builtin/code.py`)

| tool | capability | does |
|---|---|---|
| `code_projects(device)` | `code.see` | the device's projects and not-cloned repositories |
| `code_start(device, project, prompt, new?, resume_session?, model?, max_turns?)` | `code.run` | starts a job; answers the job's Anemo id, the device's job id and the folder, and that progress is on the Code page and through `code_status` |
| `code_status(job_id, wait_s?)` | `code.see` | with `wait_s` (≤ 300), first waits until the job ends ([21](21-code-wait.md)); state, todo list, the last 8 activities as one-line summaries (tool name + subject, or the first 200 characters of text), branch, PR, turns, duration, API-equivalent cost and, when ended, the result (≤ 4000 characters); all job content inside the untrusted-content marking the web tools use (`UNTRUSTED`) |
| `code_cancel(job_id)` | `code.run` | cancels |

- `job_id` accepts the Anemo id (uuid) or the device's job id (`yyyyMMdd-HHmmss-xxxx`).
- Policy categories: `code.see` "See Claude Code jobs" (default `autonomous`) and
  `code.run` "Start and cancel Claude Code jobs" (on trusted computers that allow it in
  Anemo Desktop; default `autonomous`). A watched device is refused by `run()` (and
  `actions()` says so in the summary), never asked.
- `actions()`: `code.run` with resource `device:<name>/project:<project>`, a summary
  with the first 120 characters of the prompt, risk `moderate`; `code.see` risk `safe`.
- `ToolResult.data = {"code_job_id": "<uuid>"}` for `code_start`, `code_status` and
  `code_cancel` (the chat's chip).
- `FEATURE_TOOLS["code"]`; `PAGE_INFO.code.hasTools = true`.
- The `computer_shell` description gets one sentence: for Claude Code jobs use
  `code_start` / `code_status` / `code_cancel`, not a script.

### 12.4 Frontend

- Thread header: **Cancel** while the latest job runs and its device offers `start`
  (confirm dialog; a toast with `errorMessage` on error).
- **Follow-up** box under a thread whose last job has ended, has a session and whose
  device offers `start`: a one-line box that grows, like the chat's (Enter sends,
  Shift+Enter adds a line; on a touch screen Enter adds a line); the new job appears in the
  thread and is followed live. Otherwise hidden, with one line saying why when the
  device is offline or doesn't allow starting.
- **New job** button in the list header → dialog: device (trusted computers offering
  `start`), project (a combobox fed by `GET /api/code/devices/{id}/projects`: local
  first, then "On GitHub, not cloned"; free text allowed), a "New project" switch (shown
  when the name matches nothing), prompt, model (Default, Opus, Sonnet, Haiku → null,
  `opus`, `sonnet`, `haiku`). Success → `/code/<id>`.
- A job with `conversation_id` shows "From chat: <title>" linking to `/c/<id>`.
- In the chat, a tool call of `code_start`, `code_status` or `code_cancel` whose `data`
  has `code_job_id` shows a small chip "Claude Code job" linking to `/code/<id>`.

### 12.5 Changes after the phase 2 review (these win over 12.1–12.4)

**Desktop**

- *Which `claude` runs*: the command line names the full path found on PATH (`where`
  order, PATHEXT), never a bare `claude`, and the detached start sets
  `NoDefaultCurrentDirectoryInExePath=1`; cmd runs as `cmd.exe /d /v:off /s /c "…"`. A
  `claude.cmd` in the project folder is never run.
- *GitHub owner*: `GitHubOwner` null means the account `gh` is signed in as (`gh api
  user --jq .login`, 30 s). With no `gh`, no signed-in account and no owner set,
  `code_projects` lists no remote repositories (`note` says to sign in to gh or set an
  owner) and `code_start` never clones.
- *Project names*: besides `^[A-Za-z0-9._-]{1,100}$`, a name must not be only dots, must
  not end with a dot, and must not be a Windows device name (`CON`, `PRN`, `AUX`, `NUL`,
  `COM1`–`COM9`, `LPT1`–`LPT9`, also with an extension). Same rule on the server and in
  the page. .NET patterns end with `\z`, not `$`.
- *Follow-ups*: `code_start` takes an optional `follow_job_id` (a job id). When given,
  the job runs in the folder recorded in that job's `meta.json` `dir` (which must exist
  and be a folder; else `failed` "The folder of job x is gone."), `project` is ignored
  and nothing is cloned or made. The server always sends it for a follow-up.
- *Answer fast*: `code_start` validates, resolves a local folder, makes the job folder
  and answers `{job_id, dir, project}` at once. When a clone (or `git init`) is needed,
  it answers right after making the job folder, with a `starting` file in it, and does
  the clone and the start in the background; `dir` is the folder it will clone into. A
  job with a `starting` file and no pid counts as `running` for at most 15 minutes. When
  the clone fails, the client writes the reason to `err.txt`, removes `starting`, and
  the job ends as `exited_without_result` (its stderr tail says why). So a command
  never holds the device for more than a few seconds.
- *Cancel*: after ending the process tree, the client reads `out.jsonl` again; if a
  `result` is there, it removes the `cancelled` file and answers the real state. A job
  still cloning is cancelled by stopping the clone and writing `cancelled`.
- *Offer*: unchanged on the wire; the server reads "can start now" as `code &&
  code_start && control` (the existing `control` field already says control is allowed
  and not paused).

**Backend**

- `CodeDeviceOut`: `start` = `code && code_start && control` (can start now), new
  `cancel` = `code && code_start` (cancelling doesn't need control).
- Follow-up sends `follow_job_id` = the thread's last job's `job_key`.
- `relay.Unavailable` because the device is busy with another command → `device_busy`
  (409), not `device_offline`.
- `started()` always sets `seen_running` (Anemo started the job), so a job that ended
  before the start's answer still notifies.
- Tool resources use the device id, as `computer.py` does: `device:<id>` and
  `device:<id>/project:<project>`.
- `code_status`: everything that came from the computer or the job (project, folder,
  branch, todo texts, activities, result) is inside the untrusted marking, with a marker
  that says it was written by a Claude Code job.
- `code.run` stays `autonomous` by default (the task's decision); Settings → Agent
  Permissions can make it ask.

**Frontend**

- New job dialog: the device falls back to the first usable one only while none has
  been picked; a picked device that stops being usable disables Start with a line
  saying why. The prompt is sent as typed (no trim). "New project" isn't offered for a
  name that a local folder's remote repository already has.
- Cancel shows when the device's `cancel` is true; New job and Follow-up need `start`.
- A 504 or a network error while starting: a toast says the job may have started, and
  the list and devices are refetched.
- `device_busy` is shown with the server's message, like the other codes.

## 13. Images with a prompt

The New job dialog, the follow-up box and a queued message take images: PNG, JPEG, WebP
or GIF, picked with a button, dropped on the box or pasted into its text, shown as
thumbnails that can be removed before sending (the chat's `AttachmentChip`).

- **Upload first**: each image is uploaded as soon as it is added (`POST
  /api/attachments`, as in the chat), so a request only carries ids: `POST
  /api/code/jobs` and `POST /api/code/jobs/{id}/follow-up` take `image_ids` (at most 8).
  A queued message keeps the ids (in the browser, with its text) until it is sent; so
  does a thread's draft and the New job dialog's.
- **Checks** (`code_sessions/images.py`): each id must be an image attachment (by its
  content) of at most 10 MB; it is scaled down to what a model looks at (≤ 1568 px,
  ≤ 3 MB; `attachments/images.py`), and all of one message to ≤ 8 MB together. Errors:
  `bad_image`, `too_many_images`, `images_too_large` (422) with a sentence; the computer
  must offer `code_images` (`images_unsupported`, 409: "update Anemo Desktop to 1.3.0").
  The page checks type, size and count before uploading and says why it refused a file.
- **Names**: the server names each file `<n>-<safe part of the uploaded name>.<real
  type>` (only letters, digits, `.`, `_`, `-`; no path, no leading dot); the computer
  checks the same pattern again.
- **Transport** (D15, `docs/device-contracts.md` §7.4): the `code_start` command carries
  the images as base64; the computer writes them to `<job>\images\` and lists their full
  paths after the prompt in `prompt.txt`; Claude Code opens them with its Read tool.
  Rejected alternative: `--input-format stream-json` with image content blocks would have
  needed a JSON prompt on stdin for every job, changed what `prompt.txt` holds (which
  `cc.ps1`, agents and the page read), put the image bytes in the session transcript sent
  again with every resumed turn, and needed the same JSON building in every port.
- **The row**: `code_jobs.images` (`[{id, name}]`, migration 0075) for a job Anemo started
  with images; `CodeJobOut.images`. While it has any, the job's `prompt` and `title` stay
  what Anemo sent (the computer's `prompt.txt` also has the list of paths). The thread
  shows them as thumbnails in the prompt's bubble (a tap shows one large); a queued
  message shows them too.
- **Retention**: pruning a job (§5.3) deletes its images' attachments unless a chat or a
  job that stays has them.

## 14. The usage indicator

Claude Code writes a `rate_limit_event` before most API calls (dozens per job). Real jobs
(Claude Code 2.1, `C:\anemo-bridge\jobs\*\out.jsonl`) write:

```
{"type": "rate_limit_event", "rate_limit_info": {
   "status": "allowed" | "allowed_warning" | "rejected",   // of the deciding window
   "rateLimitType": "five_hour",                           // which window decides
   "resetsAt": 1795435800,                                 // seconds since 1970
   "utilization": 0.9,                                     // only sometimes
   "overageStatus", "isUsingOverage", "surpassedThreshold", …,
   "unifiedWindows": {
     "five_hour": {"utilization": 0.49, "resetsAt": 1795435800, "status": "allowed"},
     "seven_day": {"utilization": 0.25, "resetsAt": 1795874400, "status": "allowed"},
     "seven_day_overage_included": {…}}},
 "uuid", "session_id"}
```

- **Timeline**: the page leaves these events out (`HIDDEN_EVENT_TYPES` in `timeline.ts`);
  they stay in the stored log like every other line.
- **Parsing** (`parse.rate_limit`, pure): every field is optional. Windows come from
  `unifiedWindows` (names `^[a-z0-9_]{1,40}$`, at most 8; `utilization` a number clamped to
  0–10, `resetsAt` seconds, milliseconds or ISO 8601 text, `status` text); an event with only
  the top-level fields gives one window named by `rateLimitType`. Anything else is dropped.
- **Kept per computer** (`code_usage`, migration 0084, `usage.py`): one row per device
  (the account is the computer's Claude Code login, so the device stands for it): `status`,
  `limit_type`, `resets_at`, `windows` `[{name, utilization, resets_at, status}]`,
  `observed_at`, `job_id`. The newest event of a batch replaces the row only when it is not
  older than what is stored: an event of a running job counts as true *now*, one of a job
  that has ended (a back-fill, or a computer catching up) as of the job's end. A change is
  published on the global stream as `code.usage {device_id}`.
- **API**: `GET /api/code/usage` → `{usage: [CodeUsageOut]}` (newest first):
  `device_id, device_name, status, limit_type, resets_at, windows[], observed_at, job_id`.
- **Page** (`UsageMeter.tsx`, `usage.ts`): the list's header shows each computer's usage
  (with its name when there are several), the thread's header its computer's: per window a
  thin bar and the share used (5-hour and weekly; others only in the tooltip, the
  `…_overage_included` copy never), the reset time when a window is over 80 % or was hit,
  and "as of …". A window whose reset time has passed shows "has reset" instead of an old
  share. Refetched on `code.usage` and every 5 minutes.
- **Tokens**: a `result`'s `usage` gives `code_jobs.tokens` (`{input, output, cache_read,
  cache_creation}`, `CodeJobOut.tokens`); the result card shows them next to turns,
  duration and API-equivalent cost.
