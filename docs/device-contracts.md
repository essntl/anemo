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
          "version": "1.0.0", "last_id": "<id>" | null}          first, within 10 s
server → {"type": "welcome", "device": {"id", "name", "kind", "trust"},
          "missed": bool, "cursor": "<id>"}
client → {"type": "ping"}            ← {"type": "pong"}           every ~20 s
server → {"type": "event", "id": "<id>", "event": "<type>", "data": {…}}
```

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

For `kind: "plan"` (the agent's plan waits for a review, when "review the plan first" is
on), `steps` is the plan's steps in order, as plain text: at most 30 strings of at most
200 characters each; `risk` is `"safe"`. A client that doesn't know a kind ignores the
event.

Only events of runs started by *this* device go to a phone. `voice.say` is sent for
failed and cancelled runs too, with a one-sentence text saying so.

### Commands to a computer

```
client → {"type": "device.offer", "control": bool, "shell": bool}
          on connect and every 30 s; control: "Allow control" is on;
          shell: PowerShell is switched on in the client
server → {"type": "device.command", "id": "<uuid>", "action": "<action>", …fields}
client → {"type": "device.result", "id": "<uuid>", "ok": true, "state": {…}}
client → {"type": "device.result", "id": "<uuid>", "ok": false, "error": "<one sentence>",
          "code": "stopped" | "refused" | "unavailable" | "failed"}
client → {"type": "device.stopped"}   the user pressed the stop hotkey or chose Pause
```

One command at a time per device; the server doesn't send the next before the answer.
A result for an id the connection wasn't sent is ignored. Without an offer renewed in the
last 90 s the device is offline for the agent.

## 3. Computer actions

`state` (the answer to `look` and every action except `shell`, `clipboard_set` and
`windows`):

```
{ "window": {"ref": "w3", "title": "…", "app": "EXCEL.EXE"},
  "screenshot": "<base64 PNG>",        // ≤ 1568 px on the long side; omitted for what="windows"
  "scale": 1.5,                         // screen pixels per screenshot pixel
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
| `press` | `keys: string[]` (1–10) | key names as in `companion-contracts.md` §7a, plus `Win` as a modifier; never Ctrl+Alt+Del |
| `scroll` | `direction: "up" \| "down" \| "left" \| "right"`, `amount` (1–10), `ref?` | |
| `focus_window` | `window_ref` | brings it to the front |
| `open` | `target`: a program's name from the Start menu, or an http(s) URL | starts it; URL in the default browser |
| `clipboard_set` | `text` (≤ 20 000) | `{}` |
| `shell` | `command` (≤ 8000), `timeout_s` (1–600) | `{"exit_code", "stdout", "stderr", "truncated", "duration_ms"}`; output head 20 000 + tail 10 000 characters |

- Refs are valid until the next command; a stale ref answers `failed` with
  "That control is gone; look again".
- The client refuses (`refused`) acting when control is off, `shell` when PowerShell is
  off or the device isn't trusted (the server doesn't send it then, but the client checks
  too), and typing into a password control.
- `stopped` when the user pressed the stop hotkey during the command; the server fails the
  tool call with "The user stopped control" and offers nothing more until the next offer
  with `control: true`.

## 4. Voice REST

### `POST /api/voice/turns` (multipart)

| field | |
|---|---|
| `audio` | the recording; WAV 16 kHz mono preferred; ≤ 25 MB |
| `conversation_id` | optional: continue this chat (the phone sends it within the follow-up window) |
| `status` | optional `true`: the user asked what is running; no run starts |

```
202 { "run_id": "…", "conversation_id": "…",
      "heard": "uh mail tom no tim about fridays thing",
      "request": "Email Tim about Friday's meeting." }
200 { "cancelled": true }                        the recording was only "cancel"/"never mind"
200 { "say": "Two runs are working: …" }         for status
409 { "error": { "code": "no_transcription_model", "message": "…" } }
422 too large, empty or not audio (code `unsupported_audio`, as dictation)
```

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

The `version` in `hello` is the client's. The server sends
`{"type": "notice", "text": "…"}` once per connection when a client is older than the
oldest version it supports; it keeps working where it can. A client that gets an action it
doesn't know answers `failed` with "Unknown action “…”", so an old client fails loudly.
