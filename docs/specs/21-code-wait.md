# Waiting on a code job: `code_status(wait_s=…)`

An agent that started a Claude Code job (`code_start`, [code-sessions.md](code-sessions.md)
§8, §12) used to follow it by calling `code_status` again and again: each call is a model
step, costs tokens and fills the context with the same status. `code_status` now takes
`wait_s` (0–300 seconds, default 0): the call returns as soon as the job ends (or its state
changes), else after `wait_s` with the job as it is then. Built from
[CONTRACTS-round4.md](CONTRACTS-round4.md) §7.

Written with the code (November 2026).

## What the agent sees

- `wait_s = 0` (the default): exactly today's answer, nothing waits.
- `wait_s > 0`: the usual status, with one line in front that says why the call returned:
  - `Wait: ended after 42 s, the job ended.`
  - `Wait: still running after 300 s.`
  - `Wait: none, the job had already ended.` (a job that has ended answers at once)
  - `Wait: ended after 3 s, the job's state changed.` (a change that isn't an end; no such
    state exists today besides `running`, so in practice this doesn't show, but the wait
    ends on any change of `state`, not just on the end states)
- `code_start`'s description points at `wait_s`, and says that for a long job, *if a
  `create_trigger` tool is offered*, the agent can instead ask to be woken in this chat by
  `code_job.ended`. That tool and the event are built by workstream T this round
  (§2, §7 of the contract); the wording reads right with or without it, because the
  agent only sees `create_trigger` when it exists.

Only `state` counts as a change. A new activity, a todo ticked off or a branch name doesn't
end the wait: the point is to answer once, when there is something to act on. An agent that
wants to watch progress uses a small `wait_s` or none.

## How it waits (`features/code_sessions/wait.py`)

Every time a computer reports a job, ingest (`ingest._publish`) adds a `code.job` entry with
the job as stored to the job's Valkey stream `code:{job_id}` (the stream the Code page's SSE
follows). The wait uses that stream and nothing else:

1. Take the stream's newest id (`XREVRANGE … COUNT 1`), *then* read the job's state from
   the database. In this order a change between `code_status`'s first read and the wait is
   seen by the read, and a later one arrives on the stream after the cursor.
2. `XREAD BLOCK` from that id in slices of at most 5 s (`SLICE_S`) until `wait_s` is used up.
   For each `code.job` entry, the state in the entry is compared with the starting state;
   only when it differs (or the entry has none) is the state read from the database again,
   and the wait ends if it really changed. `code.events` entries and `code.job` entries
   with the same state cost one comparison each.
3. The tool then reads the job as it always does and answers.

So the computer does nothing new (no message is sent to it), and the database is read
twice per wait plus once per real state change. The slices bound how long one blocking
read holds a connection, so a connection that died without an error is noticed within
seconds; `BLOCK 0` (block for ever) is never sent.

**Valkey down.** When taking the cursor or a read fails (`RedisError`, `OSError`), the wait
falls back to reading the state from the database every 10 s (`DEGRADED_CHECK_S`) until the
end of `wait_s`. It never fails the call because Valkey is down, and it doesn't switch back
mid-wait (a wait is at most 5 minutes). The client's own retry (`core/redis.py`) means the
first failure can take a few seconds to show.

## Cancellation, timeouts, the lease

- **The user stops the run.** The run's watcher (`runtime/lifecycle.py`) cancels the task
  the agent loop runs in, on the control signal (or the `cancel_requested` flag, checked
  every 3 s, when Valkey is down). The `CancelledError` interrupts the `XREAD` or the sleep
  at once and goes up unchanged (`run_tool` passes it on), so the run stops as it does for
  any other tool. The tool therefore needs no cancel check of its own; the test drives
  `drive_until_stopped` with a real cancel signal and checks that the same connection pool
  works for the next call.
- **The tool-call timeout.** `CodeStatus.timeout_s` is `MAX_WAIT_S + 30` (330 s): the
  longest wait plus the reads. The default 30 s would cut every long wait short.
- **The worker's lease.** A run is a queued job leased for 60 s and kept by a heartbeat
  every 10 s (`jobs/runner.py`). The heartbeat is its own task beside the handler, and the
  wait only awaits (no blocking call on the event loop), so a 5-minute call keeps its lease.
- **The run's time limit.** The wait counts toward the run's active time like any tool
  call (by default 15 minutes for the chat limits, 30 for agent runs). Capping `wait_s`
  at the time left was not done: the tool doesn't know the run's active time, and the
  limit check between steps stops the run cleanly after the call.

## The prompt cache

Tool descriptions are part of the cached prompt prefix. The change touches two descriptions
and one input schema once (one cache miss after the upgrade), and adds about 60 words in
total. Nothing in them depends on the job, the time or the run.

## Security

Nothing new: `wait_s` doesn't widen what `code_status` shows or who may call it
(`code.see`, safe). The status text is marked untrusted as before; the wait line is
Anemo's own text, outside the marked block. A wait holds one Valkey connection from the
shared pool for up to 5 s per slice; the number of waits is bounded by the number of
running runs.

## Tests

`backend/tests/api/test_code_wait.py`: argument limits and schema (and that `code_cancel`
has no `wait_s`); `wait_s = 0` doesn't wait and answers as before; a job that ends during
the wait (through a real device WebSocket and ingest), with progress before the end not
ending it; a stream entry without a state checked in the database, and no database
polling before it; the timeout path; an ended job answering at once; a change just before
the wait not missed; stopping the run; Valkey down when taking the cursor and while
reading (the database is asked every `DEGRADED_CHECK_S`, not in a tight loop), and the
timeout without Valkey; an agent turn calling `code_status` with `wait_s`.

## Limits and what's left

- A job whose computer goes offline doesn't change, so the wait runs to its end; the
  status then says the computer is offline. Ending the wait when the device goes offline
  would need the device's presence on the job stream (today it is on the global stream).
- One wait per call, at most 5 minutes. Longer: call again, or (once T's work is merged)
  an event trigger on `code_job.ended`.
