# Devices: Anemo on your Windows computers

A small program in the Windows tray, **Anemo Desktop**, that lets the agent see and use a
computer: take a screenshot, read the window you are in, click, type, open programs and,
where you allow it, run PowerShell. It runs on every Windows machine you want Anemo to
reach: the isolated VM that is the agent's own computer, your main PC and your laptop.
Each one is a **device** in Anemo with its own name and its own trust level.

Anemo itself stays where it is (Docker on ZimaOS). Nothing runs on Windows but the
client, and the client only connects out: one WebSocket to the address the web app uses,
through Nginx Proxy Manager. No port is opened on any Windows machine.

The phone app (`05-voice-android.md`) is a device too; both use the protocol in
`docs/device-contracts.md`.

## How you use it

- **Settings → Devices → Add a device**: a name ("VM", "Desk PC", "Laptop"), the kind
  (computer or phone) and the trust level (below). Anemo shows a token once; paste it into
  the client with the Anemo address. Revoking the device revokes its token and closes its
  connection at once.
- **The tray icon** is the Anemo mark on a tile that shows the state: grey (connecting, or
  trying again), dark (connected), red (the agent is acting on this computer right now),
  dark with an amber pause badge (control paused), grey with an amber “!” (not set up, or
  refused by Anemo: open Settings). Its menu: *Share this screen with Anemo*,
  *Pause control for 1 hour*, *Allow control* (on/off), *Open Anemo*, *Quit*.
- **Stop at once**: Ctrl+Alt+Shift+S (changeable) takes control away from the agent on
  this computer for an hour, cancels the command it was running, and tells Anemo, which
  fails that tool call with "The user stopped control". It works even while the agent is
  typing.
- **Share this screen** (menu or Ctrl+Alt+Shift+A): a screenshot plus the text of the
  window in front, sent once, like "Share this tab" in the browser extension. The agent
  sees it with `computer_shared_screen`. Forgotten after 12 hours.

### Trust levels

Set per device in Settings → Devices (a security-sensitive setting: the password is asked
again).

| Level | Looking (screenshot, window text) | Acting (click, type, keys, open) | PowerShell |
|---|---|---|---|
| **Watched** (default; main PC, laptop) | as the permission says | asked every time | not offered |
| **Trusted** (the agent's own VM) | as the permission says | as the permission says | as the permission says |

"As the permission says" is the level in Settings → Agent Permissions for the categories
below, so on the VM you can make acting fully autonomous while your PC always asks.
The client also refuses acting and PowerShell when *Allow control* is off on that
computer: a device can be switched to look-only without touching Anemo.

## What the agent can do

New tools in `tools/builtin/computer.py`. All take `device` (a device name; the agent sees
the online devices and their levels in its turn context when any are connected).

| Tool | Does | Capability |
|---|---|---|
| `computer_look` | A screenshot of the screen or of one window, plus the window's controls as a numbered list (Windows UI Automation: role, name, value), like the browser tools' page state. `what`: `screen`, `window` (the one in front, or `window_ref`), `windows` (the list of open windows, no screenshot). | `computer.see` |
| `computer_act` | One action: `click` / `double_click` / `right_click` (a control `ref` or `x, y`), `type` (text into a `ref` or where the focus is), `press` (keys, as in the browser contract), `scroll`, `focus_window`, `open` (a program from the Start menu by name, or a URL in the default browser), `clipboard_set`. Answers with the new state, as `computer_look`. | `computer.act` |
| `computer_shell` | One PowerShell command on a **trusted** device, with a timeout (default 60 s, at most 10 minutes), returning exit code and output (head and tail when long). | `computer.shell` |
| `computer_shared_screen` | What the user shared last ("Share this screen"). | `computer.see` |

Rules that hold whatever the permissions say (set in code, as `always_ask` or `blocked`):

- On a **watched** device every `computer_act` asks, every time (`always_ask`, like clicks
  in the user's own Chrome).
- Typing into a password field (UI Automation `IsPassword`) is refused by the client.
  The agent is told to ask the user to type it.
- Nothing is done on the secure desktop (UAC prompts, the lock screen): Windows doesn't
  allow it, and the client says so instead of trying.
- Screenshots and window text are **untrusted** content for the model, labelled as such,
  like web pages.
- Each action's screenshot is kept for the run's timeline, as the browser tools do.

### Permission categories (`policy/presets.py`)

| cap | label | default |
|---|---|---|
| `computer.see` | See your computers | ask_dangerous (looking is a safe action, so it is allowed) |
| `computer.act` | Use your computers | ask |
| `computer.shell` | Commands on your computers | ask |

Risk of each action is set by code: looking is `safe`; clicks, typing and keys are
`moderate`; `open` and `clipboard_set` are `moderate`; PowerShell is rated with the
existing `shell_risk` rules (a command that deletes, formats, changes users or the
registry is `dangerous`), and `contacts_people` is set for commands that use the network.

## Client design (Windows)

C# on .NET 8, one self-contained `.exe` (single-file publish), Windows 10 and 11, x64 and
ARM64. No admin rights needed; it runs as the logged-in user, starts with Windows (a
shortcut in the user's Startup folder), and keeps one instance per user session.

- **Connection**: `ClientWebSocket` to `wss://<anemo>/api/devices/ws`, `hello` with the
  token, `kind: "computer"`, ping every 20 s, reconnect with back-off. Commands run one at
  a time per device, in order.
- **Seeing**: screenshots with `Windows.Graphics.Capture` (falls back to GDI `BitBlt`),
  scaled to at most 1568 px on the long side, PNG. Window and control text with UI
  Automation (`System.Windows.Automation` / UIAutomationClient): the tree of the window
  in front, interactive controls numbered as `ref`s, at most 300 controls and 40 000
  characters, refs valid until the next look or action.
- **Acting**: `SendInput` for mouse and keyboard; UI Automation patterns (`Invoke`,
  `Value`, `ExpandCollapse`) first when the control offers them, as they don't depend on
  where the window is. A click by coordinates is in screenshot pixels and is scaled back.
- **PowerShell**: `pwsh` if installed, else Windows PowerShell 5.1, started with
  `-NoProfile -NonInteractive`, in a working folder set in the client (default
  `%USERPROFILE%\AnemoWork`). Only when the device is trusted *and* PowerShell is switched
  on in the client.
- **Storage**: the token with DPAPI (`ProtectedData`, current user); settings in
  `%APPDATA%\Anemo Desktop\settings.json`; a local log of commands (action and summary,
  no screenshots or typed text) for the last 7 days.
- **Indicator**: the tray icon turns red while a command runs, and a small always-on-top
  border in the corner of the screen shows "Anemo is using this computer" with a Stop
  button.

## Backend design

- **Migration 0072**: table `devices` (id, name UNIQUE, kind `phone | computer`, trust
  `watched | trusted`, token_id FK → `api_tokens` ON DELETE CASCADE, last_seen_at,
  client_version, settings jsonb). Deleting a device deletes its token.
- `features/devices/`: `router.py` (REST: list, add (returns the token once), rename,
  set trust (re-auth), delete), `ws.py` (`/api/devices/ws`), `relay.py` (commands from the
  worker to the device's connection), `shared_screen.py` (like `extension/shared_tab.py`).
- **Relay**: `extension/browser_relay.py` with the key per device instead of one global
  key: `devices:online:<device_id>` → connection id (90 s, renewed by the client's
  `device.offer`), pub/sub `devices:cmd:<conn>`, answers on `devices:res:<command_id>`.
  The worker waits up to 90 s for an answer (`computer_shell`: its timeout plus 15 s).
- **WebSocket auth**: the token in the `hello` message (never in the URL), checked again
  every minute (4401 when revoked). A connection that sends an `Origin` header (a web
  page) is refused with 4403: devices are native programs, unlike the extension, which
  must send its `chrome-extension://` origin.
- Tools in `tools/builtin/computer.py`, registered in `BUILTIN_TOOLS`; offered only when
  at least one computer is online, and not in automations unless the automation lists the
  tool (an automation on the VM is fine, one on your PC should be a choice).
- The turn context gets one line per online device: name, kind, trust, and whether
  control is allowed.

## Done when

- The client connects through NPM, shows in Settings → Devices as online, and reconnects
  after Anemo or the network restarts.
- On a watched device the agent can look without asking (with the default levels) and
  every click asks; on a trusted device with "Fully autonomous" it acts without asking.
- The stop hotkey cancels a running command and the tool call fails with the reason.
- Password fields are refused; shared screens expire.
- Tests: the WebSocket (hello, bad token, revoked token, Origin refused, offer, command and
  result routing to the right device), the tools' actions and risks for both trust levels,
  the relay timeouts, the REST routes (trust needs re-auth). The client: unit tests for
  the command handlers, and a manual test list for the UI Automation and input parts.

## Later

- macOS and Linux clients on the same protocol.
- Files between Anemo's workspace and a device (`device_file_get` / `device_file_put`).
- Watching a window over time (with the user's say-so) for longer tasks on the VM.
