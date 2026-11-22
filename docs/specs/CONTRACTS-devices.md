# Server-side contracts for the devices work (voice on Android, Windows client)

`docs/device-contracts.md` fixes what goes over the wire. This file fixes the shapes
**inside the server** that two packages could otherwise invent differently, who owns which
file, and how each package builds and tests. Packages: D1 (devices core), D2 (computer
tools), V1 (voice backend), W1 (Windows client), A1 (Android app), X1 (end to end, docs).

If your package can't be built within this file, stop and report; don't work around it.

## 1. Relay: `app/features/devices/relay.py` (owned by D1, used by D2)

The stub on the integration branch has exactly these names. D1 replaces the bodies, not
the signatures.

```python
@dataclass(frozen=True)
class Offer:
    control: bool          # "Allow control" is on in the client
    shell: bool            # PowerShell is switched on in the client

@dataclass(frozen=True)
class DeviceInfo:
    id: uuid.UUID
    name: str
    kind: Literal["phone", "computer"]
    trust: Literal["watched", "trusted"]
    control: bool
    shell: bool

class Unavailable(Exception)    # not connected, no offer in 90 s, no answer in time, Valkey down
class Stopped(Exception)        # the user pressed the stop hotkey or chose Pause
class Refused(Exception)        # the client refused (control off, shell off, password field)
class ActionFailed(Exception)   # the client tried and says why it couldn't

async def online(device_id: uuid.UUID) -> Offer | None
async def list_online() -> list[DeviceInfo]
async def send(device_id: uuid.UUID, action: str, fields: dict[str, Any],
               timeout_s: float = 90) -> dict[str, Any]
```

- `online`: the device's last offer if it was renewed within 90 s, else `None`.
- `list_online`: every device that is connected now, phones included. A computer whose
  offer is older than 90 s is still listed (with `control=False, shell=False`); whether it
  can be used is `online()`'s answer. A phone is online
  while its WebSocket is open (the server renews its entry on each ping) and always has
  `control=False, shell=False`. Sorted by name.
- `send`: one `device.command`; returns the client's `state` (for `shell`,
  `clipboard_set` and `look` with `what="windows"`: the object the wire contract gives).
  The exception's message is the client's `error` sentence, at most 500 characters.
  Result codes map to exceptions: `stopped` → `Stopped`, `refused` → `Refused`,
  `unavailable` → `Unavailable`, `failed` (or no code) → `ActionFailed`. No connection, no
  listener or no answer within `timeout_s` → `Unavailable`.
- `send` does not check trust, permissions or `Offer.control`: that is D2's job before it
  calls. It does keep "one command at a time per device": a second `send` for the same
  device waits for the first (inside its own `timeout_s`).
- After a `stopped` result or a `device.stopped` message the relay records
  `control=False` for that device until its next offer with `control: true`.
- Timeouts: D2 passes 90 s for everything except `shell`, where it passes the command's
  `timeout_s` + 15.
- Valkey keys (D1): `devices:online:<device_id>`, `devices:cmd:<conn>`,
  `devices:res:<command_id>`, `devices:lock:<device_id>`, `devices:shared_screen`. Nobody else reads them.

D2 tests against a fake that implements these three functions (monkeypatched onto the
module). D2 does not build the real relay.

## 2. Device lookup: `app/features/devices/service.py` (owned by D1, used by D2 and V1)

```python
async def by_name(db: AsyncSession, name: str) -> Device | None      # D2: the tools' `device` argument
async def by_token_id(db: AsyncSession, token_id: uuid.UUID) -> Device | None   # V1: which phone is calling
```

`by_name` trims and compares case-insensitively. Both return `None` when there is no such
device. The fields other packages may read: `id` (UUID), `name` (str), `kind`
(`"phone" | "computer"`), `trust` (`"watched" | "trusted"`). Nothing else.

The stub declares a `DeviceRef` protocol with those four fields and both functions return
`None`. D1 replaces it with the ORM model `Device` (`features/devices/models.py`); the
field names stay. D2 and V1 test with a fake row or a monkeypatched lookup, never with a
table of their own.

V1 gets the calling device from the request's session: `session.token_id` (set by
`auth.tokens.principal`) → `by_token_id`. A request without a device (the browser, the
`authed` test client) still works: the run then has no `device_id`.

### Shared screen: `app/features/devices/shared_screen.py` (owned by D1, read by D2)

Added during wave 1 (D2 reported the gap):

```python
async def current() -> SharedScreen | None
```

`SharedScreen` has `device` (the device's name), `window` (`title`, `app`), `screenshot`
(base64 PNG), `text` and `shared_at`, as in `device-contracts.md` §5. `None` when nothing
is shared or it expired. D2's `computer.current_shared_screen` is pointed at it by the
orchestrator when D2 merges.

The computer tools learn trust and offers for `actions()` (which is synchronous) from a
list refreshed at the start of each agent step (`computer.refresh(ctx)`, called from
`runtime/agent.py`, D2's lines), and check again live in `run()`.

## 3. Events

Everything a phone gets travels on the global stream (`events:global`,
`bus.publish_global`). D1's WebSocket reads that stream, as the extension's does, and
turns entries into the wire events of `device-contracts.md` §2. Computers get no events.

| wire event | global event it comes from | who publishes it | what D1 does |
|---|---|---|---|
| `run.status` | `run.status` `{run_id, status, conversation_id, …}` | existing code (`runs.service.set_status`) | forwards `{run_id, status}` |
| `approval.requested` | `approval.requested` `{run_id, conversation_id}` | existing code (`runtime/agent.py`); it carries no approval | reads the run's pending approvals from the database and sends one wire event per approval not yet sent on this connection |
| `approval.decided` | `approval.decided` `{approval_id, run_id, decision}`: **new** | **V1**, in `runs.agent_router.decide_approval`, after the commit | forwards `{approval_id, decision}` |
| `voice.say` | `voice.say` `{run_id, conversation_id, device_id, text, more}`: **new** | **V1**, when a voice run reaches a terminal status (`runtime/agent_finalize.py`) | forwards `{run_id, conversation_id, text, more}` |

- **The phone's filter** (D1): an event is forwarded to a phone only when its run has
  `runs.options["source"] == "voice"` and `runs.options["device_id"] == str(device.id)`.
  V1 sets both when it starts the run. D1 may cache the answer per run on a connection.
- **`approval.requested` on the wire** (D1 builds it): `approval_id`, `run_id`, `kind`
  (`"action"`, `"question"` or `"plan"`), `summary` (`Approval.summary`), `risk` (`ToolCall.risk`,
  `"safe"` when empty); for a question also `question` and `options` from the
  `ask_user` call's `ToolCall.args`. For kind `"plan"`: `steps`, the titles of the
  proposed plan's steps (`ToolCall.args["steps"]`), and `risk` `"safe"`.
- **`decision`** is `"approve"` or `"deny"`, as in `DecisionIn`.
- **`voice.say`** is published for `completed`, `failed` and `cancelled` voice runs. The
  shortening (Markdown out, cut at a sentence end near the limit, "The rest is in the
  chat.") is a pure function in `features/voice/` so it is unit-tested without a run.

## 4. Runs started by voice (V1)

`runs.options` gets `"source": "voice"` and, when the caller is a device,
`"device_id": "<uuid>"` and `"device_name"` (the name when it asked, for the run page;
there is no lookup by id). V1 adds an `options` argument to
`conversations.service.send_turn` / `_start_run` for this (merged into what is there);
the `/turns` route's behaviour must not change. The turn note for the listener goes in the
turn context through the same path (`runs.options["turn_note"]`, read in
`runtime/agent_snapshot.py` and passed to `turn_context.render` as one more section).

Voice decisions go through `decide_approval` (never around it) and are recorded in the
audit log with `"source": "voice"` in the entry's details.

## 5. Permission categories (`app/policy/presets.py`)

Added in wave 0, owned by D2 afterwards:

| cap | label | default |
|---|---|---|
| `computer.see` | See your computers | `ask_dangerous` |
| `computer.act` | Use your computers | `ask` |
| `computer.shell` | Commands on your computers | `ask` |

D2 may change the descriptions, not the caps, labels or defaults, and adds their
Ukrainian and Russian translations (the wave-0 stub has none).

## 6. Settings sections (`app/features/settings/sections.py`)

V1 adds `VoiceSettings`, registered as `"voice"` (not sensitive):

| field | type | default |
|---|---|---|
| `profile_id` | `uuid.UUID \| None` | `None` (the default agent) |
| `model_id` | `uuid.UUID \| None` | `None` (the agent's own model); added after the first deploy |
| `follow_up_minutes` | `int`, 0–60 | `5` (0: follow-ups off) |
| `max_spoken_chars` | `int`, 100–2000 | `600` |
| `approvals_by_voice` | `bool` | `True` |
| `chat` | `Literal["daily", "single"]` | `"daily"` |

D1 adds no section: a device's data is in its table. D2 adds none.

## 7. Migrations

D1 owns `0072_devices` (down revision `0071_speech_to_text_models`). Nobody else adds a
migration. If your package turns out to need one, stop and report.

## 8. File ownership

Add only: no reformatting, no moving or renaming of existing code. A file not listed
here and not inside your package's own folders is not yours; if you need it, report it.

| File | Who | What |
|---|---|---|
| `backend/app/features/devices/**` | D1 | everything (replaces the stubs) |
| `backend/migrations/versions/0072_devices.py`, `app/db/models.py` | D1 | the table, its import |
| `backend/app/api/router.py` | D1, V1 | each adds its own import and `include_router` lines (D1: the WebSocket router next to `extension_router`, the REST router under `protected`) |
| `backend/app/tools/builtin/computer.py` | D2 | everything |
| `backend/app/tools/registry.py` | D2 | the tools, a `has_computer` argument of `toolset_for` |
| `backend/app/policy/presets.py` | D2 | after the wave-0 stub |
| `backend/app/runtime/agent.py` | D2 | passing `has_computer` where `has_browser` is passed |
| `backend/app/runtime/agent_snapshot.py` | D2, V1 | D2: whether computers are online (`run.policy["computer"]`) and the device lines of the turn context; V1: the voice turn note. Each adds its own lines next to `extra = …`, nothing else |
| `backend/app/runtime/agent_finalize.py` | V1 | publishing `voice.say` |
| `backend/app/features/runs/agent_router.py` | V1 | `decide_approval`: the `approval.decided` global event, the audit `source`; `TimelineOut.origin` for "Asked by voice from ‹phone›" |
| `backend/app/features/conversations/service.py` | V1 | the `options` argument (§4) |
| `backend/app/features/voice/**` | V1 | everything |
| `backend/app/features/dictation/service.py` | V1 | `transcribe` and `clean_up` made public, the `voice` purpose, the yes/no classifier. Dictation's behaviour and tests must not change |
| `backend/app/features/settings/sections.py` | V1 | `VoiceSettings` |
| `frontend/src/features/devices/**` | D1 | the Settings → Devices page |
| `frontend/src/features/voice/**` | V1 | the Settings → Voice page |
| `frontend/src/features/settings/sections.ts`, `frontend/src/app/router.tsx` | D1, V1 | one line each: D1 `devices` after `dictation`, V1 `voice` after that |
| `frontend/src/features/runs/**` | V1 | "Asked by voice from ‹phone›" on the timeline |
| `frontend/src/locales/{uk,ru}/devices.ts` | D1 | new files, plus their line in each `index.ts` |
| `frontend/src/locales/{uk,ru}/voice.ts` | V1 | new files, plus their line in each `index.ts` |
| `frontend/src/locales/{uk,ru}/agents.ts` | D2 | the labels and descriptions of the three permission categories, next to the other categories |
| `frontend/src/api/openapi.json`, `schema.d.ts` | D1, D2, V1 | generated; regenerate, never edit by hand. The orchestrator regenerates after each merge |
| `desktop/**` | W1 | everything; outside it only lines in `.gitignore` and the CI job below |
| `android/**` | A1 | everything; outside it only lines in `.gitignore` and the CI job below |
| `e2e/**`, `backend/tests/integration/**`, `docs/features.md`, `docs/deployment.md`, `docs/roadmap.md`, `README.md` | X1 | the end-to-end flows and docs |

Note: Devices and Voice are **Settings** pages (like Dictation), so they go into
`SETTINGS_SECTIONS` (`features/settings/sections.ts`), not into `PAGE_INFO` or the
backend's `PageId`: those are the app's own pages that can be switched off.

Tests go where the conventions put them: `backend/tests/api/test_devices*.py` (D1),
`test_computer*.py` (D2), `test_voice*.py` (V1), `backend/tests/unit/` likewise.

## 9. CI (`.github/workflows/ci.yml`)

W1 and A1 each add exactly one job, at the end of the file, and nothing else:

```yaml
  desktop:
    name: Windows client (build, tests)
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: desktop
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-dotnet@v4
        with:
          dotnet-version: 8.0.x
      - run: dotnet build -c Release -p:EnableWindowsTargeting=true
      - run: dotnet test -c Release -p:EnableWindowsTargeting=true

  android:
    name: Android app (tests, debug build)
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: android
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-java@v5
        with:
          distribution: temurin
          java-version: 17
      # The runner image has the Android SDK (ANDROID_HOME) with its licences accepted;
      # Gradle fetches the platform and build tools the project asks for.
      - run: ./gradlew test assembleDebug
```

So `desktop/` needs a solution file at its root whose test project runs on Linux (logic
behind interfaces; the Windows-only project builds there with `EnableWindowsTargeting`),
and `android/` needs the Gradle wrapper committed.

## 10. Building and testing a package

Never the live Anemo instance; only the throwaway stack of this checkout (compose project
`anemo-devices`: its own Postgres and Valkey containers and volumes) and the fake model
provider. `make` is not installed on this machine; `sh ../anemo-progress/backend.sh` runs
the same commands. From the worktree's root:

```
sh ../anemo-progress/backend.sh <id> check      ruff, format check, mypy, lint-imports, pytest
sh ../anemo-progress/backend.sh <id> test <pytest args>
sh ../anemo-progress/backend.sh <id> gen-api    openapi.json (then: cd frontend && npm run gen-api)
sh ../anemo-progress/backend.sh <id> alembic check          against the package's test database, after a test run
sh ../anemo-progress/backend.sh <id> alembic downgrade -1   D1: 0072 must roll back (write the migration by hand, as 0071 is)
sh ../anemo-progress/backend.sh <id> fmt                    ruff --fix and format
```

| Package | Worktree | Branch | Database | Valkey db | Dev ports (if needed) |
|---|---|---|---|---|---|
| D1 | `../anemo-d1` | `feat/d1` | `anemo_test_d1` | 11 | 8181, 5181 |
| D2 | `../anemo-d2` | `feat/d2` | `anemo_test_d2` | 12 | 8182, 5182 |
| V1 | `../anemo-v1` | `feat/v1` | `anemo_test_v1` | 13 | 8183, 5183 |
| X1 | `../anemo-x1` | `feat/x1` | `anemo_test_x1` | 14 | 8184, 5184 |
| W1 | `../anemo-w1` | `feat/w1` | none | none | fake server on a free port |
| A1 | `../anemo-a1` | `feat/a1` | none | none | fake server on a free port |

Frontend checks: `cd frontend && npm ci && npm run typecheck && npm run lint && npm run
lint:imports && npm test`.

Clients on this machine: W1 builds with the .NET 8 SDK on `PATH`. A1 sets
`JAVA_HOME=C:/Program Files/Java/jdk-17`, writes `android/local.properties` with
`sdk.dir=C:/Users/user/AppData/Local/Android/Sdk` (forward slashes; never committed) and
creates the wrapper with `C:/Users/user/AppData/Local/Gradle/gradle-8.14.3/bin/gradle
wrapper`. Installed: `platforms;android-35`, `build-tools;35.0.0`; a build that needs
another SDK package downloads it itself (the licences are accepted).
