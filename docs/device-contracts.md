# Contracts between Anemo and its devices (Anemo Voice, Anemo Desktop)

What the server expects from the Android app (`05-voice-android.md`) and the Windows
client (`06-desktop-client.md`), and what they can expect from it. The server and the two
clients are built separately; if one of these has to change, change this file first and
say so. Modelled on `docs/companion-contracts.md` and the extension's WebSocket
(`features/extension/router.py`).

All paths are under the address the web app uses (behind Nginx Proxy Manager with
**Websockets Support** on). All requests carry `Authorization: Bearer anemo_…`, the
device's token, except the WebSocket, which sends it in its first message.

## 1. Devices and tokens

- A device is made in Settings → Devices; that makes an API token (`api_tokens`) tied to
  the device (`devices.token_id`). The token is shown once.
- A device token can do what an extension token can (`features/auth/tokens.py`): what a
  logged-in browser can, except changes that need the password again. Trust levels,
  permissions and providers can't be changed with it.
- Deleting the device deletes the token: its REST calls get 401 and its WebSocket closes
  with 4401 within a minute.

## 2. The WebSocket: `GET /api/devices/ws`

JSON text messages. Closes: 4400 bad first message, 4401 bad or revoked token, 4403 an
`Origin` header was sent (devices are native programs; a web page can't use this),
4409 another connection of the same device replaced this one (the newer one wins).

```
client → {"type": "hello", "token": "anemo_…", "kind": "phone" | "computer",
          "version": "1.0.0", "last_id": "<id>" | null,
          "platform": "windows" | "macos"}                         first, within 10 s
server → {"type": "welcome", "device": {"id", "name", "kind", "trust"},
          "missed": bool, "cursor": "<id>"}
client → {"type": "ping"}            ← {"type": "pong"}           every ~20 s
server → {"type": "event", "id": "<id>", "event": "<type>", "data": {…}}
```

When a device's trust level is changed in Settings, the server closes its connection with
the standard code 1012; the client reconnects as after any drop and reads the new trust
from `welcome`.

`platform` (computers, Anemo Desktop 1.4.0) is the client's operating system; missing, or
any other value, means `"windows"` (older clients). The server keeps it with the connection
and stores it with every offer (§ *Commands to a computer*).

`kind` must match the device's kind (else 4400). `missed` and `cursor` mean what they mean
on the extension's stream: after a drop, resume from `cursor`; when `missed`, fetch what
you need by REST.

### Events a phone gets

| event | data | when |
|---|---|---|
| `run.status` | `{run_id, status}` | a run this device started changes status |
| `approval.requested` | `{approval_id, run_id, kind: "action" \| "question" \| "plan", summary, risk, question?, options?, steps?}` | a run this device started waits for the user |
| `approval.decided` | `{approval_id, decision}` | decided anywhere (stop asking on the phone) |
| `voice.say` | `{run_id, conversation_id, text, more: bool}` | a run this device started finished; `text` is plain text to speak, `more` when the answer was shortened |
| `voice.stop` | `{run_id, conversation_id}` | the agent called `voice_stop` in a run this device started: the phone leaves voice mode after speaking that run's answer (Anemo Voice 1.1.0) |

For `kind: "plan"` (the agent's plan waits for a review, when "review the plan first" is
on), `steps` is the plan's steps in order, as plain text: at most 30 strings of at most
200 characters each; `risk` is `"safe"`. A client that doesn't know a kind ignores the
event.

Only events of runs started by *this* device go to a phone. `voice.say` is sent for
failed and cancelled runs too, with a one-sentence text saying so. There is **no** event
that turns voice mode on or opens the microphone: only the user does, on the phone
(docs/specs/07-voice-mode-android.md).

### Messages from a phone

| message | when |
|---|---|
| `{"type": "voice.mode", "on": bool, "cause": "tile" \| "notification" \| "phrase" \| "stop_phrase" \| "timeout" \| "voice_stop" \| "service_stopped"}` | voice mode went on or off (Anemo Voice 1.1.0) |

The server writes each `voice.mode` to the audit log (`action: "voice.mode"`, target the
device, `details: {on, cause}`, actor `agent` for `voice_stop`, else `user`) and answers
nothing. It ignores a message that doesn't validate: an unknown cause, `on: true` with a
cause other than `tile`, `notification` or `phrase`, `on: false` with `phrase`, or one
from a computer. A phone queues messages made while it isn't connected (at most 20) and
sends them after the next `welcome`.

### Commands to a computer

```
client → {"type": "device.offer", "control": bool, "shell": bool, "code": bool,
          "code_start": bool, "code_images": bool, "code_git": bool,
          "code_git_remote": bool, "shell_kind": "powershell" | "pwsh" | "zsh" | "bash",
          "files": bool}
          on connect and every 30 s; control: "Allow control" is on;
          shell: the shell is switched on in the client (PowerShell on Windows, zsh on
          macOS); code: "Share Claude Code jobs with Anemo" is on (§7); code_start: "Let
          Anemo start Claude Code jobs" is on (§7, phase 2); code_images: a code_start may
          carry images (§7.4, 1.3.0); code_git: the read-only git actions are there
          (§7.5, 1.5.0); code_git_remote: they also take `repo`, `fetch`, answer pull
          requests, and `code_git_cache_clear` is there (§7.6, 1.6.0). A missing code,
          code_start, code_images, code_git or code_git_remote means false. shell_kind (1.4.0): the shell `shell` runs in; missing, or any other
          value, means "powershell". files (1.7.0): "Let Anemo read and write files" is
          on and the device is trusted: the file actions of §8 are there; missing means
          false. code_input (1.9.0): the jobs Anemo starts take messages while they run
          (§7.4 `code_input`, `code_input_withdraw`); missing means false.
server → {"type": "device.command", "id": "<uuid>", "action": "<action>", …fields}
client → {"type": "device.result", "id": "<uuid>", "ok": true, "state": {…}}
client → {"type": "device.result", "id": "<uuid>", "ok": false, "error": "<one sentence>",
          "code": "stopped" | "refused" | "unavailable" | "failed" | "not_found"
                  | "unauthenticated" | "exists"}
          not_found (1.5.0): what the command named isn't there (a project, a commit);
          unauthenticated (1.6.0): git or gh on the computer isn't signed in to the
          remote (§7.6); exists (1.7.0): a file is already where a write would put one
          (§8). An older server takes any of them as failed.
client → {"type": "device.stopped"}   the user pressed the stop hotkey or chose Pause
```

The relay stores the offer in the device's `devices:online:<id>` hash, with `platform`
(from `hello`) and `shell_kind`; `relay.Offer` and `relay.DeviceInfo` carry both (defaults
`"windows"` / `"powershell"`, also for a hash an older server wrote). The turn context's
line of a Mac names its system and shell (`- Mac: computer (macOS, shell: zsh), trusted,
control allowed, zsh on`); a Windows computer's line is as before. The tool descriptions
are the same for every device; `computer_shell` is rated by PowerShell rules for
`powershell`/`pwsh` and by `policy/shell_risk.py` plus macOS rules for `zsh`/`bash`.

One command at a time per device; the server doesn't send the next before the answer.
A result for an id the connection wasn't sent is ignored. Without an offer renewed in the
last 90 s the device is offline for the agent.

## 3. Computer actions

`state` (the answer to `look` and every action except `shell`, `clipboard_set` and
`windows`):

```
{ "window": {"ref": "w3", "title": "…", "app": "EXCEL.EXE"},
  "screenshot": "<base64 PNG>",        // ≤ 1568 px on the long side; omitted for what="windows"
  "scale": 1.5,                         // screen units per screenshot pixel (below)
  "controls": [ {"ref": "c12", "role": "button", "name": "Save", "value": null,
                 "enabled": true, "password": false} ],   // ≤ 300
  "text": "…",                          // window text, ≤ 40 000 characters
  "truncated": false,
  "note": "…" }                         // optional: something the agent should know
```

| action | fields | does |
|---|---|---|
| `look` | `what: "screen" \| "window" \| "windows"`, `window_ref?` | the state; `windows` gives `{"windows": [{ref, title, app, minimized}]}` |
| `click` / `double_click` / `right_click` | `ref` or `x, y` (screenshot pixels) | UI Automation `Invoke` when the control has it, else the mouse |
| `type` | `text` (≤ 5000), `ref?` | into the control, or where the focus is; `refused` for a password control |
| `press` | `keys: string[]` (1–10) | key names as in `companion-contracts.md` §7a, plus `Win` as a modifier, and on macOS `Cmd` (`Win` and `Meta` are Cmd there, `Alt` is Option); never Ctrl+Alt+Del; on macOS never Cmd+Ctrl+Q or Cmd+Option+Esc |
| `scroll` | `direction: "up" \| "down" \| "left" \| "right"`, `amount` (1–10), `ref?` | |
| `focus_window` | `window_ref` | brings it to the front |
| `open` | `target`: a program's name from the Start menu (macOS: an app in the Applications folders, e.g. `TextEdit`), or an http(s) URL | starts it; URL in the default browser |
| `clipboard_set` | `text` (≤ 20 000) | `{}` |
| `shell` | `command` (≤ 8000), `timeout_s` (1–600) | `{"exit_code", "stdout", "stderr", "truncated", "duration_ms"}`; output head 20 000 + tail 10 000 characters. Windows: PowerShell `-NoProfile -NonInteractive`; macOS: `zsh -f -c` (or `bash --noprofile --norc -c`), as `shell_kind` says |

- **Coordinates.** `x`, `y` are screenshot pixels; the client maps them back with its own
  last capture: screen point = origin + (x, y) × `scale`. Screen units are physical pixels on
  Windows and **points** on macOS (the global display space: the main display's top-left is
  0,0, a display left of or above it has negative coordinates; a Retina display has 2×2
  pixels per point). A Mac's screenshot is fitted from the size in points, so its `scale` is
  about 1 on a laptop screen, not 2. `look what=screen` shows every display, arranged as in
  the system's display settings.
- Refs are valid until the next command; a stale ref answers `failed` with
  "That control is gone; look again".
- The client refuses (`refused`) acting when control is off, `shell` when the shell is
  off or the device isn't trusted (the server doesn't send it then, but the client checks
  too), and typing into a password control (macOS: a control whose role or subrole is
  `AXSecureTextField`, or any focus while macOS has secure keyboard entry on).
- `unavailable` on the secure desktop (Windows: UAC prompts, the lock screen; macOS: the
  lock screen, the login window, System Settings, password and permission prompts), and on
  macOS without the Screen Recording permission (looking) or the Accessibility permission
  (acting; looking then has no controls and a `note`), with a sentence asking the user.
- `stopped` when the user pressed the stop hotkey during the command; the server fails the
  tool call with "The user stopped control" and offers nothing more until the next offer
  with `control: true`.

## 4. Voice REST

Anemo Voice 1.1.0 first sends a request's recording to `/voice/transcripts`, matches its
voice-mode commands on what was heard, and sends anything else on to `/voice/turns` as
`text`. When `/voice/transcripts` answers 404 (an older Anemo) it sends the recording to
`/voice/turns` as before.

### `POST /api/voice/transcripts` (multipart, Anemo Voice 1.1.0)

| field | |
|---|---|
| `audio` | the recording, as for `/voice/turns` |

```
200 { "heard": "Hey Jarvis, start voice mode." }       as the transcription model heard it
200 { "heard": "", "say": "Sorry, I didn't catch that." }   nothing was heard
```

Errors as `/voice/turns` (409 `no_transcription_model`, 422 audio codes, 400
`transcription_failed`). Only transcribes: no clean-up, no run, nothing stored.

### `POST /api/voice/turns` (multipart)

| field | |
|---|---|
| `audio` | the recording; WAV 16 kHz mono preferred; ≤ 25 MB |
| `text` | instead of `audio` (1–4000 characters): the transcript `/voice/transcripts` gave, cleaned up and started as a recording would be, not transcribed again |
| `conversation_id` | optional: continue this chat (the phone sends it within the follow-up window) |
| `status` | optional `true`: the user asked what is running; no run starts |
| `voice_mode` | optional `true`: voice mode is on, the phone listens again after the answer; the agent is told so and may end it with `voice_stop` |
| `keep_chat` | optional `true`: continue `conversation_id` whatever the follow-up window says (not an archived, temporary, automation or busy chat); sent from the second request of a voice mode session on |

```
202 { "run_id": "…", "conversation_id": "…",
      "heard": "uh mail tom no tim about fridays thing",
      "request": "Email Tim about Friday's meeting." }
200 { "cancelled": true }                        the recording was only "cancel"/"never mind"
200 { "say": "Two runs are working: …" }         for status
409 { "error": { "code": "no_transcription_model", "message": "…" } }
200 { "say": "Sorry, I didn't catch that." }    nothing was heard; no run starts
422 { "error": { "code": "empty_audio" | "audio_too_large" | "unsupported_audio" } }   as dictation
```

Any other failure has the same `{"error": {"code", "message"}}` shape (for example 400
`transcription_failed` when the speech-to-text model didn't answer); a client speaks or
shows `message` and doesn't need to know the code. Whenever a 200 carries `say`, the
phone speaks it.

### `POST /api/voice/replies` (multipart)

| field | |
|---|---|
| `audio` | the spoken reply |
| `approval_id` | the approval, question or plan review it answers |

```
200 { "decided": "approve" | "deny", "heard": "…" }        answered or decided
200 { "decided": null, "heard": "…", "say": "Sorry, was that a yes?" }   unclear
409 { "error": { "code": "needs_tap" } }       a dangerous action: voice can't decide it

A plan review is decided like an action: *yes* accepts the plan as proposed, *no* rejects
it, anything else is unclear. Changing the steps is done in the app.
409 { "error": { "code": "already_decided" } } decided elsewhere meanwhile
```

## 5. Shared screen

```
PUT    /api/devices/shared-screen   { "screenshot": "<base64 PNG>", "window": {title, app},
                                      "text": "…" (≤ 40 000) }  → 200 { "shared_at", "device" }
GET    /api/devices/shared-screen   → { "screen": {device, window, shared_at} | null }
DELETE /api/devices/shared-screen   → 204
```

One shared screen at a time (a new one replaces it), kept in Valkey for 12 hours, never
returned with its content by the API; only `computer_shared_screen` gives it to the
agent, as untrusted content.

## 6. Versions

The `version` in `hello` is the client's. Anemo Desktop 1.1.0 adds Claude Code jobs
(§7, `code.*` messages and the `code` offer field); 1.2.0 adds the `code_*` actions
(§7.4); 1.3.0 adds images to `code_start` (the `code_images` offer field, §7.4) and takes
messages from the server of up to 16 MB (4 MB before). 1.4.0 adds `hello.platform` and the `shell_kind` offer field
(§2) and the macOS client (`09-desktop-macos.md`). 1.5.0 adds the read-only git actions
(§7.5, the `code_git` offer field), `local_only` for `code_projects` and the `not_found`
result code. 1.6.0 adds remote repositories and fetching to the git actions (§7.6, the
`code_git_remote` offer field, `code_git_cache_clear`, the `unauthenticated` result code).
1.7.0 adds files between the computer and the workspace (§8, the `files` offer field, the
`exists` result code). 1.9.0 adds messages for a running job (§7.4: `code_start` `input`,
`code_input`, `code_input_withdraw`, the `code_input` offer field, `code.job` `input`). 1.10.0 adds permission profiles (§9: `hello.capabilities`, the offer's
`profile_version` and `profile_pending`, `profile.sync`, `shell.analyze`, the `shell`
fields `profile_version`, `auto` and `approval`, and the `profile_stale` result code).
The server still supports 1.0.0: an older client simply sends no `code.*`. The server sends
`{"type": "notice", "text": "…"}` once per connection when a client is older than the
oldest version it supports; it keeps working where it can. A client that gets an action it
doesn't know answers `failed` with "Unknown action “…”", so an old client fails loudly.

## 7. Claude Code jobs (Anemo Desktop 1.1.0)

A computer can share the Claude Code jobs that run on it (`docs/specs/code-sessions.md`).
A job is a folder `<jobs>\<id>\` (default `C:\anemo-bridge\jobs` on Windows,
`~/anemo-bridge/jobs/<id>/` on macOS) with `prompt.txt`,
`out.jsonl` (Claude Code's `--output-format stream-json --verbose`, one event per line),
`err.txt`, `meta.json` (`{id, pid, dir, resume, started, prompt_preview}`, optionally
`model`) and, once cancelled, a `cancelled` file. Job ids match
`^\d{8}-\d{6}-[A-Za-z0-9]{4}$`. `device_job_dir` and `dir` are the device's own absolute
paths (`C:\…` or `/Users/…`): the server stores and shows them as opaque strings and never
parses them as Windows paths. Jobs are written by Anemo Desktop (§7.4) or by the bridge
for agents, `bridge/cc.mjs` (Windows, macOS, Linux), in the same format.

The client shares only when "Share Claude Code jobs with Anemo" is on **and** `welcome`
said the device is `trusted`. The server ignores every `code.*` message of a device that
isn't trusted, or isn't a computer: it stores nothing and sends no `code.ack`.

### 7.1 Messages

```
client → {"type": "code.job", "job": {
            "id": "<job id>",
            "device_job_dir": "<the job folder>",            // ≤ 1000 characters
            "project": "<last segment of dir>",              // ≤ 200
            "dir": "<the folder the job works in>",          // ≤ 1000
            "started": "<ISO 8601 with offset>",
            "prompt": "<prompt.txt>",                        // ≤ 20 000 characters
            "resume_session": "<session id>" | null,         // ≤ 100
            "model": "<model>" | null,                       // ≤ 100
            "pid": <int> | null,
            "state": "running" | "done" | "failed" | "cancelled" | "exited_without_result",
            "ended": "<ISO 8601>" | null,
            "branch": "<branch>" | null,                     // from <dir>\.git\HEAD, ≤ 255
            "stderr_tail": "<last ≤ 4000 characters of err.txt>" | null }}
server → {"type": "code.ack", "job_id": "<job id>", "seq": <int ≥ 0>}
client → {"type": "code.events", "job_id": "<job id>",
          "events": [{"seq": <int ≥ 1>, "event": {…}, "trimmed": bool}, …]}   1–200 items
server → {"type": "code.ack", "job_id": "<job id>", "seq": <int ≥ 0>}
```

- `seq` is the 1-based number of the non-blank line in `out.jsonl`. A line that isn't a
  JSON object is sent as `{"type": "raw", "text": "<line, ≤ 2000 characters>"}`.
- `code.job` goes first: when a job is discovered, when its `state`, `branch` or `pid`
  changes, and after every (re)connect for each job that isn't settled (its terminal
  state was sent and its events were acked to the end of `out.jsonl`).
- Every `code.job` is answered with a `code.ack` carrying the last `seq` the server has
  stored without a gap (0 when none). The client then sends events from `seq + 1`.
  `code.events` for a job the server hasn't been told about is ignored.
- One `code.events` frame in flight per job; the next waits for the previous one's ack.
  A frame holds at most 200 events and at most 256 KB of UTF-8. The server ignores a
  `code.events` text over 300 000 characters and a `code.job` over 64 000.
- When a job ends, its remaining events are sent before the `code.job` with the
  terminal state.
- The ack is the highest `seq` such that all of 1…seq are stored. Repeated items are
  stored once; items after a gap are stored but the ack waits for the gap to be filled.
- Each event is trimmed to at most 16 000 bytes of compact UTF-8 JSON before it is sent
  (`docs/specs/code-sessions.md` §6), `trimmed: true` when anything was cut. The server
  trims again by the same rules and may store only a stub once a job holds 5 MB.
- No ack within 60 s: the client reconnects as after a drop. Exception: when no
  `code.ack` at all came on the connection (a server without this feature), the client
  stops sharing on that connection and doesn't reconnect for it.
- Frames must keep every limit (`docs/specs/code-sessions.md` §9 and the lengths above;
  `seq` ≤ 10 000 000, `pid` 0…2³¹−1): a frame that fails validation is ignored, with no
  ack. `type` is the first key of every `code.*` message.

### 7.2 State

`cancelled` when the `cancelled` file exists; else `done` / `failed` when a `result`
event was written (`failed` when `is_error` or a `subtype` other than `success`); else
`running` while the process with `pid` lives (and started within a minute of
`started`); else `exited_without_result`. A process that can't be read counts as alive only while `out.jsonl` or `err.txt` was written in the last 30 minutes. The server also makes a job `done` / `failed`
when it stores a `result` event.

### 7.3 Privacy

Everything a job writes is untrusted content and may hold secrets. Neither side logs
event contents. The full log stays on the computer.

### 7.4 Actions (Anemo Desktop 1.2.0)

`device.command` actions, answered with `device.result` like §3. All are refused
(`refused`) when the device isn't trusted or "Let Anemo start Claude Code jobs" is off;
`code_projects` needs only sharing.

| action | fields | `state` |
|---|---|---|
| `code_projects` | | `{"projects": [{"name", "dir", "remote": "<url>" \| null}], "remote": [{"name", "url"}], "note": "…" \| null}`: folders in the projects folder (default `C:\dev`; macOS `~/dev`), and the owner's GitHub repositories not cloned yet (`gh repo list`; `note` says why when that list couldn't be read) |
| `code_start` | `project` (≤ 200), `prompt` (1–100 000), `new` (bool), `resume_session?`, `model?` (≤ 100), `max_turns?` (1–500) | `{"job_id", "dir", "project"}` once the job runs. The project resolves to a folder of that name, or a folder whose git remote has that name, else it is cloned from GitHub, else with `new` an empty folder (`git init`) is made; `failed` with a sentence otherwise |
| `code_cancel` | `job_id` | `{"job_id", "state": "cancelled"}`; ends the job's process tree and writes the `cancelled` file; `failed` when there is no such job, `{"job_id", "state": "<state>"}` when it had already ended |

A follow-up is `code_start` with `resume_session` and `follow_job_id` (the earlier job's id): it runs in that job's recorded folder, and `project` is ignored. `code_start` answers within seconds; a needed clone runs afterwards, while the job folder holds a `starting` file (see `docs/specs/code-sessions.md` §12.5 for this, the full path of `claude`, project-name rules and the GitHub owner).
The job runs `claude -p --output-format stream-json --verbose --permission-mode
bypassPermissions [--resume <s>] [--model <m>] [--max-turns <n>]` in its folder, the
prompt on stdin, like `cc.ps1`. Windows starts it through `cmd.exe` as before; macOS with
`posix_spawn` of `claude` itself (no shell), `prompt.txt` / `out.jsonl` / `err.txt` as its
stdin / stdout / stderr, as its own session and process group; `code_cancel` there ends
that process group (SIGTERM, SIGKILL after 3 s). `pid` in `meta.json` is the `cmd.exe`'s
on Windows and Claude Code's own on macOS.

**Images (Anemo Desktop 1.3.0).** A client that takes them says `"code_images": true` in
its offer (Anemo Desktop: whenever it offers `code_start`); the server sends images only
to such a client and otherwise answers the user with `images_unsupported` (409).
`code_start` (a new job or a follow-up) may then carry

```
"images": [{"name": "1-screenshot.png", "data": "<base64>"}, …]      at most 8
```

- `name` matches `^\d{1,2}-[A-Za-z0-9._-]{1,80}\.(png|jpg|webp|gif)\z` (the server makes
  it from the upload's name: a number, the safe characters of the name, the real type),
  each name once (ignoring case). `data` is the image's bytes, base64: at most 4 MB each,
  10 MB together; its first bytes must be the type its name says (PNG, JPEG, GIF, WebP).
  The server sends them scaled down to at most 1568 px and 3 MB each, 8 MB together.
  Anything else fails the command (`failed`, with a sentence), before a job folder is made.
- The client writes each one to `<job folder>\images\<name>` (never outside that folder)
  and Claude Code reads the prompt with their full paths after it, in `prompt.txt`:

  ```
  <the prompt, without trailing whitespace>

  Attached images (open each one with the Read tool):
  - C:\anemo-bridge\jobs\20261124-101500-ab12\images\1-screenshot.png
  ```

  So `--resume` works as before (nothing about the session changes), Claude Code opens
  each image with its Read tool, and the images stay in the job folder with the rest of
  the log. They are only ever files to look at: nothing runs or opens them. `meta.json`
  `prompt_preview` stays the user's own text; the `code.job` `prompt` is `prompt.txt`
  (with the list), and the server keeps the prompt as it sent it for such a job.
- A port (macOS, Linux) does the same with its own folder separators; nothing else
  depends on the platform. `cc.ps1` doesn't take images.

**Messages while a job runs (Anemo Desktop 1.9.0, Windows).** A client that has them says
`"code_input": true` in its offer. `code_start` then takes `"input": true`: the job runs
Claude Code with `--input-format stream-json --replay-user-messages`, its stdin fed by
`feed.ps1` in the job folder from the files of `<job>\inbox\` (the prompt first;
`meta.json` `"input": "stream-json"`; see `docs/specs/code-sessions.md` §15). Such a job is
`running` while its process lives (it writes a `result` per answer); its last result
decides how it ended. `code.job` gains `"input": bool` (it takes messages now).

| action | fields | `state` |
|---|---|---|
| `code_input` | `job_id`, `message_id` (a UUID: the `uuid` Claude Code echoes with `isReplay: true` when it takes the message in), `prompt` (1–100 000), `now` (bool: interrupt the current step first), `images?` (as `code_start`'s) | `{"job_id", "message_id", "state": "sent"}`; `failed` "The job no longer takes messages." when it doesn't (any more) |
| `code_input_withdraw` | `job_id`, `message_id` | `{"job_id", "message_id", "withdrawn": bool}`: false when Claude Code took it in already or the job no longer takes messages |

Both are refused like `code_start` (trusted, "Let Anemo start Claude Code jobs" on).

**Only the projects folder (Anemo Desktop 1.5.0).** `code_projects` with
`"local_only": true` lists the folders without asking `gh` for the repositories (`remote`
is then `[]`); an older client ignores the field, and the server leaves its `remote` out.

### 7.5 Read-only git (Anemo Desktop 1.5.0)

For plugins on the Code page (`code.gitGraph`, `code.gitCommit`) and the `code_git_graph`
agent tool. A client that has these says `"code_git": true` in its offer (Anemo Desktop:
whenever it shares jobs); the server sends them only then, and otherwise answers
"Update Anemo Desktop on <device>". Like `code_projects` they need a trusted device with
sharing on (not "Let Anemo start Claude Code jobs", not control).

| action | fields | `state` |
|---|---|---|
| `code_git_graph` | `project`, `limit` (1–1000, default 300), `all` (bool, default true) | `{"head": {"branch", "commit", "detached"}, "branches": [{"name", "commit", "remote", "upstream", "ahead", "behind", "current"}], "tags": [{"name", "commit"}], "commits": [{"hash", "parents", "author_name", "author_email", "date", "subject", "refs"}], "status": {"dirty", "staged", "unstaged", "untracked", "conflicted"}, "remotes": [{"name", "url"}], "truncated"}` |
| `code_git_commit` | `project`, `hash` (`^[0-9a-f]{7,40}$`) | `{"hash", "parents", "author_name", "author_email", "date", "committer_date", "subject", "body", "files": [{"path", "status", "additions", "deletions"}], "stats": {"files", "additions", "deletions"}, "truncated"}` |

- `project` is a folder name as for `code_start` (no `..`, no separators, not starting
  with a dot), of a folder that exists in the projects folder (`not_found` otherwise)
  and is still inside it once links are followed (a symlink or junction out of it is
  `refused`). No clone, no match by the remote's name.
- The client runs only these git commands, by git's full path (never a `.cmd`/`.bat`),
  with the arguments as a list (never a shell): `rev-parse`, `symbolic-ref`,
  `for-each-ref`, `log --topo-order`, `status --porcelain=v2`, `remote -v`, `show -s`
  and `diff-tree --numstat/--name-status`. Each gets 10 s. Every run has
  `-c core.quotepath=off -c core.fsmonitor=false -c log.showSignature=false
  -c color.ui=never --no-optional-locks`, `GIT_TERMINAL_PROMPT=0`, `GIT_NO_LAZY_FETCH=1`
  and `LC_ALL=C`, so a repository's config can't make a read run a program, fetch, or
  take a lock a job's git would wait for.
- Output is NUL-separated (`-z`, `%x00`, `%00`) and parsed field by field; a record that
  doesn't read is left out. Commits are newest first in topological order, `limit + 1`
  are read so `truncated` can be told. `refs` are `HEAD`, branch names and `tag: <name>`.
  A merge's files are against its first parent; `additions`/`deletions` are null for a
  binary file; at most 1000 files.
- Only metadata: never file contents or diffs. Credentials in http(s) remote URLs are
  removed (the server removes them again, and holds the whole answer to its shapes,
  with every list and string capped).
- A commit that isn't in the repository is `not_found`; a folder that isn't a repository,
  or a git command that fails or takes too long, is `failed` (never git's own error text).

### 7.6 Remote repositories, fetching and pull requests (Anemo Desktop 1.6.0)

For the Code page's Git view and the same plugin methods and tool. A client that has these
says `"code_git_remote": true` in its offer (with `code_git`); the server sends `repo`,
`fetch` and `code_git_cache_clear` only then ("Update Anemo Desktop on <device> to 1.6.0").

| action | fields | `state` |
|---|---|---|
| `code_git_graph` | `project` **or** `repo` (`owner/name`), `limit`, `all`, `fetch` (bool, default false) | §7.5's, plus `"source": "local" \| "remote"`, `"repo": "owner/name" \| null`, `"fetched_at": "<ISO 8601>" \| null`, `"fetch_error": "<sentence>" \| null`, `"pull_requests": [{"number", "title", "head_ref", "url", "draft"}] \| null`; `status` is `null` for a remote repository |
| `code_git_commit` | `project` **or** `repo`, `hash` | §7.5's plus `"committer_name"` (1.6.1) (for `repo`: `additions`/`deletions` are `null`, renames aren't detected) |
| `code_git_cache_clear` | none | `{"removed": <repositories>, "bytes": <freed>}` |

- **`repo`: only the owner's repositories.** `owner/name` must match
  `^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$` (name not `.`/`..`, not ending in
  `.git`), `owner` must be the GitHub owner of §7.4 (Settings, else `gh api user`), and
  `name` must be in that owner's `gh repo list` (the list `code_projects` answers under
  `remote`, kept 10 minutes). The clone URL is the one in that list, never one sent by the
  server. Anything else is `not_found`. `project` and `repo` together, or neither, is
  `failed`.
- **The cache.** A remote repository is read from a blobless bare clone in the client's own
  data folder (`<app data>/git-cache/<owner>/<name>.git`, lower case; never the projects
  folder, so neither `code_projects` nor a job sees it), made with
  `git clone --bare --filter=blob:none --no-tags <url> <dir>` and brought up to date with
  `git fetch --prune --filter=blob:none origin +refs/heads/*:refs/heads/* +refs/tags/*:refs/tags/*`.
  It is fetched when it is made, when `fetch` is true, and when its last fetch is more than
  10 minutes old. The folder must still be inside the cache folder once links are
  followed. A clone gets 3 minutes and a fetch 60 s; a clone that takes longer or grows
  past 1 GB is removed and answered `failed` ("too large to read without cloning").
  After each clone the least recently read repositories are removed until the cache holds
  at most 3 GB (never the one just read). `code_git_cache_clear` removes all of it.
- **`fetch` on a local checkout**: `git fetch --prune --all --no-recurse-submodules` before
  reading (60 s), with hooks turned off (`core.hooksPath` set to an empty folder of the
  client's), `protocol.ext.allow=never` and `protocol.file.allow=never`. It changes only
  remote-tracking refs and FETCH_HEAD, never the working tree or a branch. When it fails or
  times out the graph is still answered, from what is there, with `fetch_error` saying so
  (never git's own text). `fetched_at` is FETCH_HEAD's time (null when never fetched).
- **Credentials**: git and gh use the computer's own (gh as git's credential helper);
  `GIT_TERMINAL_PROMPT=0`, so a missing sign-in fails at once: a clone or fetch that is
  refused for that is `unauthenticated` (for a local `fetch`: a `fetch_error`).
  Credentials never leave the computer; URLs in answers have them removed.
- **Pull requests**: when gh is on the computer and signed in, and the repository is on
  github.com (a local checkout: its `origin`), `gh pr list --repo <owner/name> --state open
  --limit 100 --json number,title,headRefName,url,isDraft,state` (argv, 15 s, kept 2 minutes
  unless `fetch`). `pull_requests` is null when it can't be read: no gh, not signed in, not
  on GitHub, a timeout. The server attaches them to the branches by `head_ref`.
- In a bare cache, `branches` are the remote's branches (`remote: false`, no upstream),
  `head.branch` its default branch; nothing returns file contents or diffs here either.

## 8. Files between the computer and the workspace (Anemo Desktop 1.7.0)

For the agent tools `device_file_get` (a file on the computer into the workspace) and
`device_file_put` (a workspace file onto the computer); design and reasons in
`docs/specs/22-device-files.md`. A client that has these says `"files": true` in its offer:
Anemo Desktop does so while *Let Anemo read and write files* is on (off by default) **and**
`welcome` said the device is `trusted`. The server sends the actions below only to a trusted
computer whose fresh offer says `files: true`.

### 8.1 Actions

`device.command` actions, answered with `device.result` like §3. All of them are `refused`
when the device isn't trusted, the switch is off, or the user paused control (the stop key;
`file_write_abort` excepted). *Allow control* is not needed.

| action | fields | `state` |
|---|---|---|
| `file_stat` | `path`, `hash` (bool, default false) | `{"kind": "file" \| "folder", "size": <bytes> \| null, "modified": "<ISO 8601>", "sha256": "<hex>"?}`; `sha256` of the whole file only with `hash` and for a file of at most 200 MB; `not_found` when there is nothing at `path` |
| `file_read` | `path`, `offset` (≥ 0), `length` (1 … 4 194 304) | `{"data": "<base64>", "sha256": "<hex of these bytes>", "size": <the file's size now>}`; fewer bytes than `length` only at the end of the file |
| `file_write_begin` | `path`, `size` (0 … 209 715 200), `sha256` (hex, the whole file), `overwrite` (bool, default false) | `{"transfer": "<id>", "chunk_bytes": 4194304}`; `exists` when a file is at `path` and `overwrite` is false; `failed` when a folder is; missing folders on the way are made |
| `file_write_chunk` | `transfer`, `offset`, `data` (base64, ≤ 4 MB of bytes), `sha256` (hex of these bytes) | `{"received": <bytes so far>}` |
| `file_write_end` | `transfer` | `{"path": "<the final path, links followed>", "size", "sha256", "replaced": bool}` |
| `file_write_abort` | `transfer` | `{}` (also for a transfer that is already gone) |

- **Paths** are the computer's own absolute paths (`C:\Users\me\x.pdf`, `/Users/me/x.pdf`),
  at most 1000 characters, no control characters: opaque strings on the server, as in §7. A
  relative path, or one with `.` or `..` parts, is `failed`.
- **Chunks.** The server reads and writes 1 MB chunks (about 1.4 MB as base64: inside the
  12 MB the server takes as a result and the 16 MB a 1.3.0+ client takes as a command); the
  client takes up to 4 MB. Chunks of a write come in order: `offset` must be the number of
  bytes received so far.
- **Hashes, both ends.** Every chunk carries the SHA-256 of its bytes; the receiver checks
  it. A read: the server compares each chunk's hash (asking for a chunk once more when it
  doesn't match, then giving up) and, at the end, the hash of the whole file with
  `file_stat`'s (a file that changed meanwhile is not saved). A write: the client checks
  each chunk and, at `file_write_end`, reads the temporary file back and compares its
  SHA-256 with the begin's; the server compares the end's `sha256` with its own.
- **No partial file under the final name.** A write goes to a hidden temporary file in the
  target's folder (`.<name>.anemo-<8 hex>.part`, the same drive, so the rename is atomic) and
  is renamed to `path` only at a successful `file_write_end`. A wrong chunk (hash, order, too
  many bytes), a wrong whole hash, too few bytes, `file_write_abort`, or **60 s without a
  chunk** drop the transfer and delete its temporary file; any later chunk for it is
  `failed` ("That copy isn't open any more"). At most 4 writes are open at once
  (`unavailable` beyond that).
- **Overwrite.** Without `overwrite` an existing file is never replaced: `exists` at the
  begin, and again at the end when a file appeared meanwhile (it is left as it is). With
  `overwrite` the rename replaces it.
- **Limits.** The client copies at most 200 MB either way; the server's own limit is a
  setting (Settings → Devices, 1–200 MB, default 50) checked before the first chunk.
- **Timeouts** (server): 30 s per chunk command, 90 s for `file_stat` with `hash` and for
  `file_write_end` (they hash the whole file); the server sends `file_write_abort` after any
  failure once a write began, and the client's 60 s rule cleans up when even that is lost.
- **Log.** The client's command log keeps the action, the path, offsets and sizes, never
  the data.

### 8.2 Which folders (the client's rule)

A path is used only when, with every symbolic link and junction on the way followed (again
and again until nothing changes), it is

1. inside one of the **allowed folders**: the folders listed in Anemo Desktop's Settings
   (*Folders for files*, full paths separated by `;`), or, when none are listed, the user's
   home folder (`%USERPROFILE%`, `~`); and
2. below that folder, has **no hidden part** (a name starting with `.`: `.ssh`, `.aws`,
   `.gnupg`, `.config`, `.git`, `.zshrc`, …); and
3. not in the home folder's **system folder**, whatever Settings lists: `AppData` on
   Windows (browser profiles, credentials, the Startup folder), `Library` on macOS
   (keychains, mail, `LaunchAgents`); and not in **Anemo Desktop's own data folder** (its
   settings, the protected token, the logs); and
4. on Windows, not a network or device path (`\server\…`, `\?\…`) and without a `:`
   past the drive letter (no alternate data streams).

Anything else is `refused` with a sentence saying why. The server doesn't know the rule;
it is the client's to keep, as the trust checks are.


## 9. Permission profiles (Anemo Desktop 1.10.0)

The design is in `docs/specs/25-device-permission-profiles.md`. A computer's permissions are a
**profile**: one level per category (`see`, `act`, `shell`, `files`, `code`), each one of
`allow`, `ask`, `deny`, `folders` (the work folders decide) or `policy` (no device layer; the
Agent Permissions alone, which is what Trusted (legacy) does). The device also has its own
**work folders**, **protected-folder levels** and the "Unrestricted for automations" switch.
Everything is managed in Anemo. The device keeps a copy and checks every `shell` against it.

**Hello and offer.**

```
client → {"type": "hello", …, "capabilities": ["profiles", "shell.analyze"]}
client → {"type": "device.offer", …, "profile_version": 7, "profile_pending": false}
```

- `profiles`: the client takes `profile.sync`.
- `shell.analyze`: the client analyses PowerShell commands (the Windows client; macOS has no analyser yet).
- `profile_version`: the version of the profile the client **enforces**.
- `profile_pending`: a loosening waits for the user's click on the computer (below).

The server keeps both in the online hash (`relay.Offer.capabilities`, `profile_version`,
`profile_pending`). A client without `capabilities` is an older one: the server sends it no
`profile.sync` and no `shell.analyze`, and decides as before (Trusted (legacy) rules).

**`profile.sync`** is a `device.command`. The server sends it right after `welcome` to a
client with `profiles`, and again whenever the device's permissions change.

```
server → {"type": "device.command", "id", "action": "profile.sync",
          "profile": {"version": 7,
                      "profile": {"id", "name": "Scoped", "preset": "scoped" | null},
                      "categories": {"see": "allow", "act": "ask", "shell": "folders",
                                     "files": "folders", "code": "ask"},
                      "work_folders": [{"path": "C:\\dev", "recycle": false,
                                        "added_from": "settings"}],
                      "protected": {"anemo": "hard", "keys": "deny", "system": "ask", …},
                      "relevance_check": true, "automations_unrestricted": false}}
client → {"type": "device.result", "id", "ok": true,
          "state": {"applied": true, "version": 7, "pending": false}}
```

- The client stores the copy in its data folder (`permissions.json`, on the hard floor).
- It never replaces a newer copy with an older one.
- Work-folder paths may hold `%USERPROFILE%`, `%TEMP%`, `%TMP%`, `%LOCALAPPDATA%`, `%APPDATA%` and `%PROGRAMDATA%`.

**"Confirm loosened permissions on this computer"** is a switch in Anemo Desktop's settings window. It is off by default and is never set by the server. With it on, a sync that loosens anything is held: the client answers `applied: false, pending: true`, shows a notification, and keeps enforcing the old copy until the user allows the change there. These count as loosening:
- a looser category;
- a new work folder;
- a protected folder from deny to ask;
- the relevance check off;
- "Unrestricted for automations" on.

Tightening applies at once.

**`shell.analyze`** asks the device what a command would do, before the server decides. The server waits 3 s at most; without an answer it decides by the old rules, and the approval says so.

```
server → {"type": "device.command", "id", "action": "shell.analyze", "command": "…"}
client → {"type": "device.result", "id", "ok": true,
          "state": {"verdict": "allow" | "ask" | "deny",
                    "effects": [{"kind": "read" | "write" | "delete" | "run",
                                 "path": "C:\\dev\\anemo\\logs", "recursive": true,
                                 "work_folder": "C:\\dev", "recycle": false}],
                    "unknown": ["variable $p used as a path (remove-item)"],
                    "rule": "delete inside work folder C:\\dev",
                    "network": false, "profile_version": 7, "pending": false}}
```

`verdict` is `"unavailable"` when the client can't parse PowerShell. Analysing never runs anything: the client parses the command with PowerShell's own parser in a helper process that only parses (`powershell.exe -NoProfile`).

**`shell` gains three fields** (sent only to a client with `profiles`):

```
server → {…, "action": "shell", "command", "timeout_s", "profile_version": 7,
          "auto": {"rule": "delete inside work folder C:\\dev"}}
       or {…, "approval": {"id": "<approval id>", "scope": "once" | "folder" | "hour"}}
```

The client analyses the command again (cached by its hash) and refuses:
- `refused` when its own copy says deny;
- `refused` when it says ask and no `approval` came;
- `profile_stale` when `profile_version` is newer than its copy (including while a loosening waits for confirmation).

On `profile_stale` the server sends `profile.sync` again and tries once more. An older server takes `profile_stale` as failed.

**The hard floor** is fixed in the client's code, on every profile, Unrestricted included: Anemo Desktop's own data folder and its install folder are never written, deleted, read or run by a command.

**What this protects against:**
- It stops server bugs and a stale server-side profile.
- It does not stop a compromised server or Anemo account. Whoever controls Anemo controls the profile; Anemo's login is the boundary (spec 25 §6.1).
