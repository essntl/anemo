# Automation scripts: flows that run without a model

Workstream C of round 3 (`docs/specs/CONTRACTS-round3.md`). Brief: a **Scripts** tab inside
Automations for flows that run without a model, mostly written by agents, so an automation
can mix cheap deterministic code with model steps. Not a second automation system.

## 1. The design in one paragraph

A script is **an automation of kind `script`**. It has the same row in `automations` as an
agent automation, so it shares the schedule, "Run now", the change check, the run log,
notifications (`notify`), `on_ask`, retries, the failure streak, "Pause all", the
time limit and the tool-call limit. Instead of a prompt for a model, it has **versions of
TypeScript code** (`script_versions`). Each run is a normal `runs` row (`kind="script"`)
in its own conversation, like an agent automation's run, so it gets the actor
`automation:<id>/<run id>` (provenance), its tool calls are `tool_calls` rows in the run's
timeline, approvals are the normal approval cards, and changes go through `record_change`.
The code runs in **Deno** with no permissions except its own folder; it reaches Anemo only
by sending JSON requests over stdin/stdout to the worker, which performs every call through
the same policy path the agent loop uses. Code written or changed by anything other than the
user in the app is saved **unapproved** and the automation is switched **off**; only the
user, with the password confirmed, approves a version (and only the approved version, by
its hash, ever runs).

## 2. What exists and what is reused (verified in the code)

| Need | Reused |
| --- | --- |
| Triggers | `automations.fire_due`, `change_check.run_check`, `retry_run`, `run_now` (all call `start_run`, which now makes a script run for a script automation) |
| Overlap rule, approvals not blocking later runs | `may_start`, `busy_run`, `pending_duplicate` |
| Results, notifications, failures | `agent_finalize.finalize` → `automations.on_run_finished` (outcome line, `notify`, nothing-to-do, retries, `count_failure`) |
| Provenance | `runs.actor_for(run)` → `Actor.automation(automation_id, run_id)`, set with `acting_as` around every tool call |
| Change list | `automations.record_change` |
| Policy | `policy.engine.evaluate` / `combine`, the snapshot built from `profiles.effective_settings`, `compile_policy`, `compile_ceiling`, `mcp_tool.snapshot` (as `agent_snapshot.snapshot_run` and `change_check._prepare` build it) |
| Approvals | `approvals` rows, `runs/agent_router.decide_approval` (re-queues the run), `on_needs_approval` |
| Model step (`think`) | the sub-agent machinery (`runtime/subagents.py`): a child run whose parent waits (`waiting_subagent`), `wake_parent` re-queues it |
| Secrets | `features/secrets` (encrypted with `APP_SECRET_KEY`) |

**No activity log with undo exists** (CONTRACTS-round3 §1). Scripts need none: what a script
did is the run's timeline (`tool_calls`), its change list, and `created_by`/`updated_by` on
the items it wrote. No new table for provenance. The only provenance addition is display:
`ActorOut.automation_kind` (`"agent"` / `"script"`), so the app can say "the script X".

**The per-call decision lives inside `AgentRun`.** A refactor commit (no behaviour change)
moves the parts that decide and run one call into `runtime/tool_calls.py`:
`decide(...)` (actions → policy verdict, with the contacts rule), `run_tool(...)` (timeout,
`acting_as`, errors as results) and `change_for(...)` (the change-list entry). `AgentRun`
calls them; the script runner calls them too. No policy rule is copied.

## 3. Data model (migration `0075_automation_scripts`)

`automations` gets one column:

- `kind` `String(10)`, default and server default `"agent"`: `agent` | `script`. Every
  existing automation is an agent one and behaves as before.
- `script_hash` `String(64)` nullable: the hash of the **approved** version that runs.
  Null: nothing is approved yet, nothing runs.

New table `script_versions` (one row per saved version, never edited):

| Column | Type | Notes |
| --- | --- | --- |
| id, created_at, updated_at | IdMixin, TimestampMixin | |
| automation_id | FK `automations` ON DELETE CASCADE, indexed | |
| number | Integer | 1, 2, 3… per automation |
| code | Text | ≤ 100 000 characters |
| tools | JSONB list of str | the tools the code may call (its allowlist) |
| hosts | JSONB list of str | hosts `anemo.fetch` (http_request / read_web_page) may reach |
| secrets | JSONB list of str | names of the secrets the code may use |
| think_tools | JSONB list of str | tools a `think` step's agent may use (default none) |
| hash | String(64) | sha256 of the canonical JSON of the four above plus the code |
| created_by | String(120) | actor reference of who saved it (`user`, `chat:<id>`, `automation:<id>/<run>`) |
| approved_at | DateTime nullable | set when the user approved it |

New table `script_secrets` (values for a script's named secrets, set by the user):

| Column | Type | Notes |
| --- | --- | --- |
| id, timestamps | | |
| automation_id | FK CASCADE | |
| name | String(60) | `^[A-Z][A-Z0-9_]*$`, unique per automation |
| secret_id | FK `secrets` ON DELETE CASCADE | the encrypted value (kind `script`) |

Derived, not stored: the **approved version** is the one whose `hash = automations.script_hash`
(and `approved_at` set); the **pending version** is the newest version when it is newer than
the approved one. The **owner** is the first version's `created_by` (shown with `describe()`).

`Schedule` gets a fifth kind, `manual` ("only when started": Run now, `run_script`), which
never comes due. Only scripts use it; agent automations' dialog never offers it.

The script's description is stored in `automations.prompt` (shown on the card; never sent to a
model). Code-related fields of an agent automation (`tool_allowlist`) are not used for a
script: its tools are part of the version, so changing them is a code change that needs
approval.

## 4. The SDK (what the code sees)

The code is an ES module that exports a default async function:

```ts
export default async function main(input, anemo) {
  const open = await anemo.call("mcp__artemk__open_requests", {})
  for (const r of JSON.parse(open.content)) {
    if (needsDecision(r)) {
      const advice = await anemo.think("Is this request urgent? Answer yes or no.", r)
      if (advice.startsWith("yes")) await anemo.call("send_notification", { title: "Urgent", body: `#${r.id}` })
    }
  }
  await anemo.tasks.create({ title: "Review bookings" })
  return { outcome: `checked ${open.length} requests` }
}
```

- `input`: `{trigger, input, state, change}`: what started it (`schedule`, `manual`,
  `retry`, `tool`), the JSON an agent passed to `run_script`, the automation's state note,
  and what the change check found. All of it is data.
- `anemo.call(tool, args) → {content, data, isError}`: any tool by its registered name
  (built-in, or `mcp__<server>__<tool>`). A refused or failed call throws `ToolError`
  (`.denied` true when the policy or the user said no); the script may catch it.
- Short forms for the common tools: `anemo.tasks.create/update/list`, `anemo.events.create/
  update/list`, `anemo.notify(title, body)`, `anemo.state.set(note)`. They are only
  `anemo.call` with a fixed name.
- `anemo.fetch(url, {method, headers, body, json})`: `http_request` (any method) with the
  declared-host check; `anemo.secret("NAME")` gives a placeholder (`{{secret:NAME}}`) that
  the worker replaces in request headers only, never a value the code can read.
- `anemo.think(prompt, data, {json}) → string` (or parsed JSON): a model step (§7).
- `anemo.log(...)`, and `console.log` etc.: lines kept with the run (capped).
- The return value is the run's result.

## 5. How a call gets from the sandbox to the tool layer

The Deno process has no database, no Anemo credentials, no network, no environment and no
files except its folder. It speaks newline-delimited JSON on stdin/stdout with the worker
(`runtime/script_run.py`):

```
script → worker  {"type":"call","tool":"create_task","args":{...}}
                 {"type":"think","prompt":"…","data":…,"json":false}
                 {"type":"log","text":"…"}
                 {"type":"done","result":…}   |  {"type":"error","message":"…"}
worker → script  {"type":"result","content":"…","data":{…},"is_error":false,"denied":false}
                 {"type":"stop"}
```

For each request the **worker**: checks the tool is in the approved version's `tools`
(never scripts' own tools, schedule writes or `ask_user`, which are refused at save time
too), validates the arguments with the tool's `Input`, checks the declared hosts for
`http_request` / `read_web_page`, then calls `tool_calls.decide` with the run's policy
snapshot, the ceiling, the run's grants and the automation's contacts rule, records a
`tool_calls` row (args, actions, risk, decision), runs the tool with `acting_as(the run's
actor)`, records the change with `record_change`, and answers. Only one request is in flight
at a time (the SDK awaits each one).

## 6. Approvals: a journal, so the script never holds a worker

When a call's verdict is `ask`, the automation's `on_ask` decides, as for agent runs:

- `deny`: the call is refused (`ToolError` with `denied`), the script goes on.
- `fail`: the run stops and fails ("needed approval"), no retry.
- `pause` (default): an `approvals` row is made, **the Deno process is stopped**, the run
  becomes `waiting_approval`, and the user is notified as for any automation. After the
  decision the run is queued again and **the script starts again from the top** with the same
  input, but every call it already made is answered **from the journal** (its `tool_calls`
  row, matched by position, tool and arguments) instead of being run again. The approved
  call then runs for real, and the script carries on.

Why a journal and not "re-run and hope it's idempotent": earlier calls (a task created, a
notification sent) would happen twice. Why not keep the process alive: an approval can take
a day. The cost of the journal: **the script must make the same calls in the same order up
to the point where it waited** (the same input, no `Date.now()` or random values in the
arguments of calls before an approval). A script that makes a different call at a journalled
position fails with "the script did not repeat its earlier calls", and nothing else runs.
The same journal covers a `think` step and a worker crash (a call that was running when the
worker died is repeated only if the tool is idempotent, as in the agent loop).

An approval that an earlier run of the same automation already waits for (same tool, same
arguments) is not asked again (`pending_duplicate`): the call is refused for this run.

## 7. `anemo.think(prompt, data)`

A model step, built on sub-agents: the script run starts a child agent run
(`parent_run_id` = the script run) and waits for it like a run waits for a sub-agent
(`waiting_subagent`, no process, no worker). When the child ends, `wake_parent` queues the
script run, which replays its journal and gets the child's answer as `think`'s result.

- The child uses the automation's profile and model (as its agent runs would) and only the
  version's `think_tools` (default: none, so it can only reason). Its own tool calls follow
  the normal rules: the profile's permissions, the script's policy as an ancestor (it can
  never do more than the script), the automation's contacts rule and `on_ask`.
- Its task message is written by the worker: the prompt (from approved code: trusted),
  then `data` serialised as JSON inside `<untrusted_data source="script data">…`
  (`tools/untrusted.py`), with the rule that it is data and never instructions. `data` is
  never put in the system prompt or outside the untrusted block.
- Its budget is what the script run has left (`subagents.remaining_budget`), and its cost
  counts against the script run.
- `{json: true}`: the answer is parsed as JSON (a code fence around it is allowed); an answer
  that isn't JSON throws.

## 8. Saving, approving, enabling

| Who saves | What happens |
| --- | --- |
| An agent (`create_script`, `update_script`), in a chat or an automation run | A new version, **not approved**. The automation is switched **off** (`enabled=false`). The approved version, if any, stays, so the UI shows the diff. |
| The user in the Scripts tab (HTTP, password confirmed) | A new version, approved at once (the user wrote or saw it). |
| The user approves a pending version (HTTP, password confirmed) | `approved_at` is set, `script_hash` becomes its hash. The request carries the hash the user looked at: if a newer version arrived meanwhile, it is refused (409). Approving can switch the script on. |
| The user discards a pending version | It is deleted; the approved one stays. |

- **Nothing unapproved runs.** `start_run` refuses a script without `script_hash`; the
  worker loads the version by that hash, recomputes the hash from its content and refuses a
  mismatch; the run records the hash (`run.options.script.hash`) so a run that waits for an
  approval continues with the version it started with.
- **Switching on** (`PATCH enabled=true`, the Scripts tab's toggle) needs an approved version
  and no pending one ("review the change first"); switching off is always allowed.
  `update_schedule` refuses script automations (except switching them off), so an agent
  can't switch one on with an approval card that doesn't show the code.
- **Password.** Approving code and saving code in the app need the password entered
  recently (`require_recent_auth`), as MCP servers and permissions do: approved code runs
  unattended for as long as it is on, and a device token (the browser extension) must not be
  able to grant that. Switching a script on or off, running it and discarding a change don't.
- `run_script` (agent) runs only an approved script that is on and has no pending change.
  "Run now" by the user runs the approved version even when the script is off (as for agent
  automations).

## 9. The sandbox: Deno, not the shell sandbox

| | Deno (in the worker image) | The `sandbox` container (`execd`) |
| --- | --- | --- |
| Network | none (no `--allow-net`); all I/O through the worker | none or **all** (`sandbox-net`); no per-host rule |
| Files | `--allow-read/--allow-write=<its folder>` only | the **whole workspace** mounted |
| Env, subprocesses, FFI | denied (no `--allow-env/run/ffi/sys`) | a full shell |
| Memory | `--v8-flags=--max-old-space-size=<MB>` per process | container-wide 2 GB, shared with agent commands |
| Channel to the worker | stdin/stdout of a child process | HTTP to execd; a callback would need a new endpoint and token |
| Testable here | yes: Deno installs per user on this VM, and is in CI's image | no Docker on this VM |

**Decision: Deno**, run by the worker as a child process with
`deno run --no-prompt --no-config --no-lock --no-remote --no-npm --cached-only
--allow-read=<folder> --allow-write=<folder> --v8-flags=--max-old-space-size=<MB>`, an empty
environment (only what Deno itself needs: `DENO_DIR` in the run's own temporary folder,
`NO_COLOR`, and on Windows `SYSTEMROOT`), working directory = its folder. The code and the
harness are in a separate temporary folder the script can't read; `--no-remote --no-npm`
means it can't load code from anywhere. The container's isolation is per-workspace, not per
script, and its network is all or nothing; Deno's permissions are exactly the brief's rules,
and stdin/stdout is a channel that needs no new endpoint or token. The worker image gets the
Deno binary (`COPY --from=denoland/deno:bin-<version>`). What Deno does not give: a CPU limit
beyond the wall-clock limit, and kernel-level isolation (a V8 or Deno escape would be in the
worker container, which has the database credentials). That risk is accepted because only
user-approved code runs there.

- **Folder**: `<DATA_PATH>/scripts/<automation id>/` (kept between runs; not in the
  workspace, so file tools and the shell don't see it, and it goes with the automation).
- **Limits**: time = the automation's `max_runtime_s` (capped by "a scheduled run is stopped
  after N minutes"), counted per segment as the agent loop counts it (waiting doesn't count);
  tool calls = `max_tool_calls`; memory 256 MB; each message ≤ 1 MB, the log ≤ 64 KB, the
  result ≤ 64 KB (more fails the run). A run that reaches a limit fails, as an agent
  automation with its own limits does.
- The runner is behind `ScriptRunner` (`start(code, folder, limits) → ScriptProcess` with
  `send`, `receive`, `stop`), so tests use an in-process fake.

## 10. Secrets

The version declares secret names; the user sets their values in the Scripts tab (password
confirmed; write-only; shown as `••••1234`). In code, `anemo.secret("NAME")` returns the
placeholder `{{secret:NAME}}`. The worker replaces placeholders **only in the headers of an
`http_request` to a declared host**; anywhere else a placeholder stays text. The `tool_calls`
row stores the arguments with the placeholder, never the value; the value is removed from
the response before it goes back to the script or into the row. Values are never logged,
never given to a model, never in a result.

## 11. Script output is data

- The result is stored as the run's answer (shown in the run log and its conversation)
  inside a code block, with an `Outcome:` line from `result.outcome` (a string) or "The
  script finished". `notify` decides as for agent runs whether it goes out as a notification.
- It is never given to a model as instructions: only `think`'s `data` reaches a model, inside
  the untrusted block. A later agent run of another automation reads it, if at all, through
  tools that already mark results as untrusted.

## 12. Prompt-injection paths and what stops each

| Path | Stop |
| --- | --- |
| A web page or email asks a chat agent to write a script that sends data out | The script is saved unapproved and off; the user sees the code (and its tools, hosts, secrets) before approving. Creating one asks first (`scripts.manage`, default "ask"). |
| An agent changes an approved script to do something else | The change is a new pending version; the script is switched off at once; the diff is shown. |
| An agent switches a script on, or runs a changed one | `update_schedule` refuses scripts; `run_script` refuses a script that is off or has a pending change; `start_run` and the worker run only the approved hash. |
| Data the script reads (booking notes, web pages) steers a `think` step | The data is inside an untrusted block; the think agent has only `think_tools` (default none) and its calls are checked as usual. Its answer is a string to the code, which decides what to do. |
| The script's result steers someone | It is shown to the user as data; no model reads it as instructions. |
| A script calls a tool it didn't declare | Refused by the worker before the policy is even asked. |
| A script reaches a host it didn't declare | No network in the sandbox; `http_request`/`read_web_page` to an undeclared host is refused; safe_http still refuses private addresses. |
| A device token approves code | Approving needs the password entered recently; tokens never count as that. |

## 13. Tools and capabilities

`tools/builtin/scripts.py` (owned by C), capabilities in `policy/presets.py`:

- `scripts.manage` ("Scripts", default **ask**): `create_script(name, description, code,
  tools, hosts, secrets, think_tools, rrule?/at?)`, `update_script(id, …)`. Both save an
  unapproved version. Summary in the approval card: name, tools, hosts, code size.
- `scripts.run` ("Run scripts", default **ask**): `run_script(id, input)`. Starts a run and
  returns at once (the result is in the run log; the agent can read it with `read_script`).
- `list_scripts`, `read_script(id)` (`automation.read`, already allowed): the scripts, a
  script's approved and pending code, its last runs and their results (results marked as
  untrusted for the model).
- Script tools are not offered to `think` runs and can't be called from scripts. Like the
  schedule tools, they belong to the Automations page (`FEATURE_TOOLS`).

## 14. API

All under `/api/automations/{automation_id}/script` (login required):

- `GET` → `ScriptOut`: kind info, approved and pending versions (`ScriptVersionOut`: number,
  hash, code, tools, hosts, secrets, think_tools, created_by as `ActorOut`, created_at,
  approved_at), owner (`ActorOut`), secrets set (names with masked values).
- `POST /api/automations/scripts` (recent auth) → a new script automation from the app
  (approved at once, off until switched on).
- `PUT …/script` (recent auth) → save a new version from the app (approved at once).
- `POST …/script/approve {hash, enable}` (recent auth).
- `DELETE …/script/pending` → discard the pending version.
- `PUT …/script/secrets/{name}` (recent auth), `DELETE …/script/secrets/{name}`.
- Existing: `PATCH /api/automations/{id}` (enable/disable, schedule, notify, on_ask, limits),
  `POST …/run`, `GET …/runs` (the run log; script runs show their result there),
  `GET /api/runs/{id}/timeline` (their calls).

`AutomationOut` gets `kind`, `script_pending` (bool) and `script_approved` (bool).
`AutomationRunOut` is unchanged (the result is the run's answer, in its conversation).

## 15. UI (`frontend/src/features/automations/`)

- Automations page: two tabs, **Automations** (agent ones, as today) and **Scripts**.
- Scripts tab: a list of script cards: name, description, schedule, status, owner ("Written
  by the assistant in <chat>" with a link, or "by the automation X"), a badge "Change waiting
  for review", the enable switch (disabled while a change waits, with the reason), Run now,
  History (the same run log component), Review.
- Review / code view: the approved code, or the diff between the approved and the pending
  version (line diff), plus a diff of tools, hosts, secrets and think tools; buttons
  "Approve" / "Approve and switch on" / "Discard change". Secrets: set or clear values.
- "New script" (from the app): name, description, code, tools, hosts, schedule.
- Every text through `t()`, Ukrainian and Russian in `locales/{uk,ru}/automations.ts`.

## 16. Done when

1. Existing automations behave exactly as before (the whole suite passes unchanged).
2. A script an agent creates doesn't run until the user approves it: not on schedule, not by
   Run now, not by `run_script`.
3. A change by an agent disables the script and the API returns both versions for the diff;
   approving needs the hash the user saw and the password.
4. A script can't call a tool outside its list, nor fetch an undeclared host.
5. A call that needs approval follows `on_ask`: deny → the script gets an error and goes on;
   fail → the run fails; pause → the run waits, and after approval replays its journal (no
   call runs twice) and finishes.
6. What a script creates carries `automation:<id>/<run id>` as provenance, the run's
   timeline lists its calls, the change list has them, and `describe()` says it was a script.
7. `think` passes `data` only inside an untrusted block; its answer comes back to the
   script; the think run's own calls follow the rules.
8. The sandbox: no network, no env, no files outside its folder, memory/time/output limits
   (Deno tests, skipped where Deno isn't installed).
9. Secrets: placeholders are replaced only in headers to declared hosts, never stored or
   returned.
10. The Scripts tab lists scripts, shows code and diff, owner, runs, and the enable switch;
    e2e spec `e2e/tests/scripts.spec.ts`.

## 17. Not done, and why

- A script **as a step** of an agent automation: `think` covers model steps inside scripts;
  an agent calls a script with `run_script`. No step-chaining engine.
- Webhook or event triggers: none exist yet (spec 02 §2.8); scripts would get them for free.
- CPU limits beyond wall-clock time, and kernel isolation of the Deno process (§9).
- A code editor with syntax highlighting: a plain monospace text area.
