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
  and started no later than one minute after `meta.started` (guards against pid reuse).
- **Persisted state**: `%APPDATA%\Anemo Desktop\code-jobs.json`: per job `{acked_seq,
  acked_offset, sent_state, settled}`; written after each ack (temp file, then move).
  Jobs older than 14 days are forgotten. A damaged file starts empty (the server's acks
  repair it).
- **Trimming**: §6, before a frame is built; `trimmed: true` on the item.
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

`ws.py` hands `code.job` / `code.events` of a computer to `code_sessions.ingest` (the
devices feature imports code_sessions, not the other way round). Each frame: validate
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
  todos (latest `TodoWrite` `input.todos` by seq), PR URL
  (`https://github\.com/[\w.-]+/[\w.-]+/pull/\d+` in tool results, assistant text and the
  result), branch (D12), and the `result` fields. A `result` event makes the job
  terminal (`done` / `failed`).
- **Over 5 MB** (`stored_bytes`): later events are stored as stubs
  `{"type": <type>}` with `dropped: true`, except `result` events and assistant events
  holding a `TodoWrite` call, which are still stored (trimmed). `truncated` is set.
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
`code.prune` (gated to once every 10 minutes): delete jobs with `started_at` older than
`keep_days` (events cascade). The client never re-announces a settled job, so pruned
jobs don't come back.

### 5.4 HTTP API (all under `protected`)

| method, path | body / query | answer |
|---|---|---|
| `GET /api/code/jobs` | `project?`, `state?`, `device_id?`, `limit` (1–500, 200), `before?` (ISO, started_at of the last row) | `CodeJobListOut {jobs: CodeJobOut[], projects: string[], has_more}` |
| `GET /api/code/jobs/{id}` | | `CodeJobDetailOut {job: CodeJobOut, thread: CodeJobOut[]}` (thread in start order, includes the job) |
| `GET /api/code/jobs/{id}/events` | `after_seq` (≥ 0, 0), `limit` (1–2000, 500) | `CodeEventsOut {events: CodeEventOut[], last_seq, has_more}` |
| `GET /api/code/jobs/{id}/stream` | `Last-Event-ID` header | SSE: `code.events`, `code.job`; the first read doesn't block |

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

1. Remove known copies: `tool_use_result.originalFile`, `tool_use_result.file.content`
   (Read), `tool_use_result.content` (Write, the same text is in the `tool_use` input).
   Removing counts as trimming.
2. If over `limit`: cut every string longer than 2000 characters to its first 1500 and
   last 400 characters joined by `"\n… [N characters trimmed] …\n"`.
3. If still over: the same with 400 / 100.
4. If still over: replace the event with `{"type", "subtype"?, "anemo_trimmed": "too
   large"}` (plus `message.content[].{type,name,id}` of tool calls when present).

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
    `parent_tool_use_id` = the call's id — nested inside), anything else (name, input
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
