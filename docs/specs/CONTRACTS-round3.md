# Contracts for round 3 (voice mode, scripts, macOS desktop)

Shared names and file ownership for the three parallel workstreams of 2026-11-24. Each
workstream has its own branch from `main` and its own pull request; nothing is merged by
the agents. If a workstream can't do its work within this file, it says so in its pull
request (and the orchestrator decides); it doesn't work around it.

| Id | Branch | Spec it writes |
| --- | --- | --- |
| A | `feat/roadmap-refresh` | – (this file, `docs/roadmap.md`, the round's log) |
| B | `feat/voice-mode-android` | `docs/specs/07-voice-mode-android.md` |
| C | `feat/automation-scripts` | `docs/specs/08-automation-scripts.md` |
| D | `feat/desktop-macos` | `docs/specs/09-desktop-macos.md`, `docs/specs/09-desktop-macos-mac-testing.md` |

## 1. There is no activity log: what each workstream records instead

Audit (workstream A, `docs/roadmap.md` → *Activity log with undo*): Anemo has **no**
general activity log with provenance and undo. What exists and is reused:

- **Actor context** `app/core/actor.py`: `current_actor()`, `acting_as(Actor…)`; references
  `user | external | chat:<id> | automation:<automation id>/<run id>`. Services that write
  documents, tasks and events record `created_by` / `updated_by` from it.
  `features/provenance/service.py` `describe()` turns references into labels.
- **Run timeline**: every tool call is a `tool_calls` row of its run (args, actions,
  decision, result).
- **Run changes** `features/automations/service.py` `record_change(db, run_id, {tool,
  summary, ref})`, called by the agent loop for every changing tool call in an automation
  run (`runtime/agent.py`, `Tool.changes()` / `ToolResult.changed`).
- **Audit log** `features/audit/service.py` `record(db, action, actor="user"|"agent"|"system",
  target_type, target_id, details)`: security- and privacy-relevant actions.

Decisions (no new table this round, nobody creates an `activity` table):

- **C (scripts)**: a script runs **as a run of an automation** (a `runs` row with the
  automation's id), so its actions carry `Actor.automation(automation_id, run_id)` as
  provenance, appear in the run's timeline as tool calls, and changing calls go through
  `record_change`, exactly as for an agent automation. "From script X" is shown by
  `describe()` labelling the actor with the automation's name and its kind (C may extend
  `ActorOut` with an optional field, e.g. `automation_kind`, and owns that change). No new
  actor kind. If C finds the run model can't carry a script run cleanly, C may add the
  minimum (columns on `runs` or `automations`) in its own migration and documents it.
- **B (voice mode)**: each voice mode on/off is reported by the phone to the server
  (§3 below) and written with `audit.record(db, "voice.mode", actor=…, target_type="device",
  target_id=<device id>, details={"on": bool, "cause": <cause>})`; `actor` is `"agent"`
  for `voice_stop`, `"user"` otherwise. It is also logged on the phone (logcat and the
  app's own history). The PR notes that this is the audit log, not an activity log.
- **D**: records nothing new (device actions are already tool calls in run timelines).

## 2. Tools, capabilities and approvals (all workstreams)

- Every new tool follows CLAUDE.md's recipe and goes through the existing policy engine
  (`policy/engine.py`) and approvals (`tool_calls` / `approvals`, as `runtime/agent.py`'s
  `AgentRun` uses them): no workstream adds a second approval path.
- **Scripts (C)** call tools only through the same decision path the agent loop uses (the
  automation's allowlist, the `always_ask` rules for contact tools in automation runs,
  the permission levels, approvals, `Actor` set around each call). There is no separate
  tool executor class today: the per-call logic lives in `AgentRun`. C extracts what it
  needs into a shared module **without changing the agent loop's behaviour** (a
  refactor commit of its own, CLAUDE.md), or calls it as it is. How a script waits for an
  approval (pause and resume, or the automation's `on_ask`: pause / skip / stop) is C's
  design decision, written in its spec. A script never gets a database
  session, a shell or the network except as described in its spec.
- Tool names reserved:
  - B: `voice_stop` (in `tools/builtin/voice.py`, a new file owned by B). It only ever
    turns voice mode **off**; there is no tool, setting or event by which the model or
    anything the model reads turns it on or opens the microphone.
  - C: `create_script`, `update_script`, `run_script` (and `list_scripts` / `read_script`
    if needed) in `tools/builtin/scripts.py` (new, owned by C). A script created or
    changed by an agent is saved **disabled**.
  - D: no new tools; changes descriptions / risk rules in `tools/builtin/computer.py`
    and `tools/builtin/code.py` for the shell type (D owns those files this round).
- Capabilities reserved (each needs a category in `policy/presets.py`; each workstream
  appends its own entry and changes nothing else there):
  - B: `voice.control` (label "Voice mode", default allow; actions are `safe`).
  - C: `scripts.manage` (create / update: default ask) and `scripts.run` (default ask).

## 3. Wire changes (`docs/device-contracts.md`)

`docs/device-contracts.md` is changed by B and D in **different sections**; each adds
only, and bumps nothing the other owns.

- **D owns** §2 `hello` and `device.offer`, §3 and §7. Additions (all optional, so old
  clients and an old server keep working):
  - `hello` gets `"platform": "windows" | "macos"`; missing means `"windows"`.
  - `device.offer` gets `"shell_kind": "powershell" | "pwsh" | "zsh" | "bash"`; missing
    means `"powershell"`. The relay stores it with the offer (`devices:online:<id>` hash,
    field `shell_kind`), `Offer` gets the field, and the turn context's device line says
    it ("shell: zsh"). The tool *descriptions* stay the same for every device (the tool
    list is part of the prompt cache): `computer_shell`'s description becomes
    shell-neutral and points at the device line; risk rules pick PowerShell or POSIX rules
    by `shell_kind`.
  - §7: job folders on macOS are `~/anemo-bridge/jobs/<id>/`, projects in `~/dev/<name>`;
    `device_job_dir` and `dir` are the device's own absolute paths (the server treats them
    as opaque strings and never parses them as Windows paths). The `out.jsonl` stream-json
    format is unchanged, so the Code page needs no change.
  - `press` on macOS: `Cmd` is accepted as a modifier (and `Win` maps to Cmd there); D
    documents it in §3.
- **B owns** the phone part of §2 (*Events a phone gets* and a new *Messages from a
  phone* table). Additions:
  - client → server `{"type": "voice.mode", "on": bool, "cause": "tile" | "notification" |
    "phrase" | "stop_phrase" | "timeout" | "voice_stop" | "service_stopped"}`: the server
    validates it, writes the audit entry of §1 and answers nothing.
  - server → phone event `voice.stop` `{run_id, conversation_id}`: the agent called
    `voice_stop` in a run this phone started; the phone leaves voice mode after speaking
    the run's answer. There is **no** event that turns voice mode on.

## 4. File ownership (hotspots)

"Append" means: add your lines, don't reformat, move or rename what is there.

| File | Owner(s) and how |
| --- | --- |
| `docs/roadmap.md`, `docs/specs/ORCHESTRATION-LOG-round3.md`, this file | A |
| `docs/device-contracts.md` | B (phone sections) and D (computer sections), §3 |
| `docs/features.md` | B: *Voice from your phone*; C: *Automations*; D: *Devices* (+ rename the heading if it stops being Windows-only). Each edits only its section. |
| `backend/app/tools/registry.py` | B and C append to `BUILTIN_TOOLS` (and `FEATURE_TOOLS` if needed) |
| `backend/app/policy/presets.py` | B and C append one category each (§2) |
| `backend/app/runtime/agent_snapshot.py` | D: the device lines; B: a voice-mode note only if needed. Separate hunks. |
| `backend/app/features/devices/` (`ws.py`, `relay.py`, `service.py`) | D (platform, shell_kind); B may add the `voice.mode` message handling and the `voice.stop` forward in `ws.py` as a separate function, nothing else |
| `backend/app/features/voice/` | B |
| `backend/app/features/automations/`, `features/runs/` (script parts), `runtime/` (a script runner module) | C |
| `backend/app/features/provenance/` | C |
| `frontend/src/features/automations/` | C |
| `frontend/src/features/settings/` device pages | D only if the shell type is shown |
| `android/` | B |
| `desktop/` | D (and the Windows client must keep working: D adds, doesn't restructure) |
| `.github/workflows/ci.yml`, `release.yml` | D (a macOS job); B and C don't touch CI |
| `frontend/src/api/openapi.json`, `schema.d.ts` | generated: each PR regenerates after its last backend change; the PR merged second regenerates again after rebasing |
| `frontend/src/locales/*` | each adds its own keys in its own area file |

## 5. Migrations

Latest on `main`: `0074_code_job_starters`. Only **C** expects to add migrations (next
number `0075_…`). B and D should need none (device platform and shell kind live in the
relay's Valkey hash; phone settings live on the phone). If B or D needs one after all, it
numbers it `0076_…` (B) / `0077_…` (D) with `down_revision` pointing at `0074`, and the
orchestrator re-chains at merge time.

## 6. Environment on this VM

No Docker, no `make`. A local toolchain is in `C:\dev\anemo\.local-env\` (see its
`README.md`): `backend.sh <worktree> <name> check|lint|gen-api|<pytest args>` with a
database `anemo_test_<name>` per workstream (`b`, `c`, `d`), `dotnet.sh`, `android.sh`,
and Deno. Known failures on this machine are listed in `KNOWN-FAILURES.md` there. CI on
the pull request (Linux, plus D's macOS job) is the final check: after pushing, each
workstream watches `gh pr checks` and fixes what fails.
