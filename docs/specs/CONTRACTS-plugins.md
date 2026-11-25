# Plugin contract, version 1

This file is the **public contract** between Anemo and a plugin: what a plugin package
contains, what it may ask for, where its UI can appear, how its UI talks to Anemo, and which
states an installed plugin goes through. Once plugins exist outside this repository, every
line of §1–§6 is expensive to change, so it is deliberately small. The why of the design is
in `12-plugins.md`; §7–§9 at the end are the *internal* agreements between this round's
workstreams (HTTP API, file ownership), which can change freely later.

Rules for the contract itself:

- **Only explicit extension points.** A plugin sees named slots, named methods and named
  permissions. It never gets a database row, a React component, a CSS class of the app, a
  route of the internal API, the session cookie or a token. Anything not listed here does
  not exist for a plugin, so Anemo's internals can change without breaking plugins.
- **Additive evolution.** Version 1 can gain optional manifest fields, slots, methods,
  permissions and events without a new version; a plugin that uses one an older Anemo
  doesn't know is refused at install with a clear message (unknown fields are errors, not
  silently ignored, so a plugin never half-works). Removing or changing the meaning of
  anything is a new `manifestVersion`, and Anemo keeps accepting version 1.
- **Everything is checked by the host, twice.** The page that embeds a plugin checks a call
  before sending it; the server checks it again against the approved version. A check in the
  page is for a quick, clear error; the server's check is the one that counts.

---

## 1. The package

A plugin is a folder (installed as a `.zip` of it, from a Git repository, or written by an
assistant inside Anemo). At its root is `anemo-plugin.json`, the manifest (§2).

```
word-count/
  anemo-plugin.json      the manifest (required)
  README.md              shown on the plugin's page (optional, Markdown, rendered like a document)
  icon.png               the card icon (optional; PNG or WebP, square, at most 256 KB)
  ui/panel.html          a UI entry (§3): HTML, plus the .js and .css files it references
  ui/panel.js
  scripts/sync.ts        a script (§2.3, runs in the existing Deno script sandbox)
  templates/meeting.md   a template body
```

| Rule | Why |
| --- | --- |
| At most **500 files**, **5 MB** unpacked, **1 MB** per file, paths ≤ 200 characters | Keeps review possible and storage bounded; a plugin is small glue, not an app bundle with images. |
| Paths are relative, `/`-separated, without `..`, `.` segments, backslashes, a leading `/`, or names starting with `.` | The same path rules as the workspace; no file can land outside the plugin's folder. |
| No symlinks, devices or empty directories; a zip may wrap everything in one top-level folder (it is removed) | Zips made by "compress folder" on any OS work. |
| Allowed file types: `.json .md .txt .html .css .js .mjs .ts .png .webp .woff2` | Text files can be reviewed and diffed; the only binaries are pictures and fonts, checked by their content like appearance uploads. No `.svg` (it can carry script), no executables, no `node_modules`. |
| Text files are UTF-8 | So diffs and reviews are exact. |

**Integrity.** For each installed version the server records the SHA-256 of every file and
the **package hash**: SHA-256 of the lines `"<path>\t<sha256 of the file>\n"` sorted by path
(so it does not depend on zip order or timestamps). Approving a version names this hash; the
files are checked against it again when they are served or registered. A marketplace later
signs exactly this hash.

## 2. The manifest (`anemo-plugin.json`)

```jsonc
{
  "manifestVersion": 1,
  "id": "anemo.word-count",          // stable, globally unique, never reused (§2.1)
  "version": "1.0.0",                // semver; every installed version must be higher
  "name": "Word count",              // ≤ 40 characters
  "description": "Words, characters and reading time for the document you have open.", // ≤ 200
  "author": { "name": "Anemo", "url": "https://github.com/essntl/anemo" },  // url optional, shown as text
  "license": "MIT",                  // optional, SPDX id
  "icon": "icon.png",                // optional
  "readme": "README.md",             // optional
  "permissions": ["documents:read"], // §4; everything the plugin may do at run time
  "contributes": { … }               // §2.2–§2.4; everything the plugin adds
}
```

Validation is strict: unknown keys are refused (see the rules above), every string has a
length limit, and every reference (a file, a script id, a template id, a property key used
by a view) must resolve inside the package.

### 2.1 Identity and versions

- `id`: `^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$`, 3–64 characters, at least two dot
  separated parts, e.g. `artem.today-board`. The first part names the author; `anemo.` is
  reserved for plugins shipped with Anemo. The id is how Anemo recognises an update of the
  same plugin, how data is attributed (`plugin:<id>@<version>`) and later how a marketplace
  lists it. It never changes; a renamed plugin keeps its id.
- `version`: semver `MAJOR.MINOR.PATCH` with an optional `-prerelease`. A package with the
  same id is an update only if its version is higher than every version already stored
  (no downgrades: going back is "approve the older stored version" in the UI, not a new
  upload). Re-uploading identical files (same package hash) is a no-op.

### 2.2 Declarative contributions (no code)

Each item has an `id` (`^[a-z][a-z0-9-]{0,39}$`, unique within its kind in this plugin).
Anemo creates the real object (a property, a saved view, an automation…) when a version is
approved, updates it when a later version is approved, and remembers that the plugin owns
it (§5, uninstall). The user can see and change these objects like any other; a plugin
never gets a handle to edit them at run time except through its permissions.

| Key | Item | Becomes | Notes |
| --- | --- | --- | --- |
| `properties` | `{id, key, label, type, appliesTo, options?}` | a property definition | `type` and `appliesTo` as in Settings → Properties (`select multi_select text date number checkbox`; `document task event`). If the `key` already exists with the **same type**, the plugin uses it and doesn't own it (it is not removed on uninstall); a different type refuses the install. |
| `views` | `{id, name, layout, query}` | a saved view | `layout`: `list table board`; `query` is the saved-view query (types, text, properties, sort, group_by, columns); its property keys must exist or be declared above. |
| `templates` | `{id, kind, title, file?, task?}` | a template, used by commands (`newFromTemplate`) | `kind: "document"` takes a Markdown `file` (frontmatter allowed); `kind: "task"` takes `task: {title, description?, priority?, tags?, checklist?}`. |
| `automations` | `{id, name, prompt, schedule, tools?}` | an agent automation, **created switched off** | `schedule` as `create_schedule` takes it; `tools` is its tool allowlist. It runs as any automation with the user's permission levels; the user switches it on in Automations. |
| `scripts` | `{id, name, description, file, tools, hosts?, secrets?, thinkTools?, schedule?}` | a script automation (spec 08) | The `.ts` file is its code; it is approved together with the plugin version (same review, no second approval) and runs in the existing Deno sandbox. Its `tools` and `hosts` must be covered by the plugin's permissions (§4.3). `schedule` defaults to `manual` (started by a command, the plugin's UI or the user). Secret values are set by the user after install, never shipped. |
| `mcpServers` | `{id, name, transport, url?, command?, args?, headerNames?, envNames?}` | an MCP server | `http`/`sse`: the URL's host must be in a `network:` permission. `stdio`: runs in the mcp-host container. Header/env values are set by the user after install. Every tool of a plugin's server is **always ask** until the user changes that tool in Settings → MCP. |
| `profiles` | `{id, name, description, instructions, icon?, skills?}` | an agent profile | **No permission levels, limits or plan-review settings**: those stay the user's; a plugin profile uses the defaults. `skills` names skills of the same plugin. |
| `skills` | `{id, name, description, file, icon?, hint?, userInvocable?, modelInvocable?}` | a skill (slash command) | `file` is the Markdown instructions. The slug is the `id`; an existing slug refuses the install. |
| `themes` | `{id, name, appearance}` | an appearance preset the user can apply | `appearance` is the subset of Settings → Appearance without uploads: `mode? accent? tint? tintStrength? uiFont? codeFont? glass? glassStrength? background?` (background `none` or `gradient`), checked like the appearance settings. Never applied automatically. |
| `commands` | `{id, title, icon?, keywords?, action}` | an entry in the command palette (Ctrl+K) | `action` is one of `{type: "openPage", page}`, `{type: "runScript", script, input?}`, `{type: "newFromTemplate", template}`. `page`, `script` and `template` are ids from this manifest. |

Why these and not more: each maps onto something Anemo already has (except templates and
command actions, which are small and needed by the examples), so a plugin can't do anything
through a contribution that the user couldn't do by hand, and the user manages the result
in the place they already know.

Static text in the approved version (a skill's instructions, a profile's instructions, an
automation's prompt) **is** given to models as instructions: the user reviewed it as part
of the version, exactly as they review code. Anything a plugin **produces at run time** is
data (§6.4).

### 2.3 Logic

Plugins never run code inside Anemo's server processes. Logic runs in two existing places:

- **Scripts** (above): TypeScript in Deno with no network, no files except its own folder,
  reaching Anemo only through tool calls the worker checks (spec 08). A plugin's UI or
  command can start its own scripts; agents can run them with `run_script` like any script.
- **MCP servers** (above): a program in the mcp-host container or a remote server. Their
  tools become agent tools (`mcp__<server>__<tool>`), permission-checked per call.

Agent tools implemented by a plugin script are **not** in version 1 (a script run is an
asynchronous automation run with its own approvals; nesting one inside an agent's tool call
needs a second waiting mechanism). A plugin that wants to give agents tools ships an MCP
server.

### 2.4 UI contributions (`contributes.ui`)

```jsonc
"ui": [
  { "id": "panel", "slot": "object.panel", "objects": ["document"], "title": "Word count",
    "entry": "ui/panel.html", "height": 140 },
  { "id": "today", "slot": "page", "title": "Today board", "icon": "calendar-check",
    "entry": "ui/today.html" },
  { "id": "settings", "slot": "settings", "entry": "ui/settings.html" },
  { "id": "kanban", "slot": "chat.block", "fence": "today-kanban", "entry": "ui/block.html" }
]
```

`entry` is an HTML file of the package. `icon` is the name of an icon in Anemo's icon set
(lucide names such as `calendar-check`); an unknown name shows the plugin's own icon.
`height` is the starting height in CSS pixels (40–800; the frame can ask to resize, §6.3).

## 3. UI slots

| Slot | Where it appears | `context` the frame gets | Count |
| --- | --- | --- | --- |
| `object.panel` | On a **task** (in the task's details column), a **document** (a tab of the document's side panel) or an **event** (below the event's fields): the kinds in `objects` | `{object: {type: "task"\|"document"\|"event", id}}` | any |
| `page` | A full page at `/plugins/<id>/<ui id>`, listed under **Plugins** in the sidebar's page list and in Ctrl+K | `{page: "<ui id>", params: {…query string}}` | any |
| `settings` | The **Settings** tab of the plugin's own page in Settings → Plugins | `{}` | at most 1 |
| `chat.block` | In a chat answer, in place of a fenced code block whose language is `fence` | `{block: {lang, text}}` | any |

- A slot is used only if declared; the install review lists each one ("Adds a panel to
  documents").
- `fence`: `^[a-z][a-z0-9-]{2,39}$`; it can't be a language Anemo draws itself (`mermaid`,
  `chart`, `math`) or one another **enabled** plugin already uses (the install says which).
  A `chat.block` frame only gets the block's text: it's the model's output, so it is
  **untrusted input for the plugin**, and nothing the frame shows goes back to a model.
- Commands are not frames: they are declarative (§2.2).

## 4. Permissions

A permission is a string in `permissions`. Nothing else grants anything: a plugin with no
permissions can show its UI, keep its own small storage (§6.2) and read its own context,
nothing more.

### 4.1 The list

| Permission | Allows | Risk |
| --- | --- | --- |
| `tasks:read` | list and read tasks (and the projects they're in) | low |
| `documents:read` | list, search and read documents | low |
| `events:read` | list and read calendar events | low |
| `projects:read` | list projects | low |
| `tasks:write` | create and change tasks (deleting goes to the trash) | medium |
| `documents:write` | create and change documents | medium |
| `events:write` | create and change events (deleting goes to the trash) | medium |
| `notifications:send` | send you a notification | high |
| `network:<host>` | HTTP requests to that host, made by the server through the guarded client (`*.example.com` = its subdomains) | high |
| `tools:<tool name>` | call that agent tool (built-in, or `mcp__<server>__<tool>`) | high, or **critical** (below) |

**Critical** is every tool whose capability is device control, shell or computer use:
`shell.*`, `computer.*`, `browser.*`, `code.run`, `agent.spawn`, `focus.control`,
`voice.control`, and any tool Anemo marks as acting on a device later. A critical permission
can be granted, but **it never runs without asking**: every single call shows the approval
dialog (or, for scripts, the automation's approval path). "Allow for this run" or "always"
don't exist for it. `settings.*` and `secrets.*` capabilities don't exist for plugins at all.

`ui` slots are declared in `contributes.ui`, not here; the review shows them as low risk.
Contributions that create things (`mcpServers`, `scripts`, `automations`, `profiles`,
`skills`) are shown in the review with their own risk: an MCP server is high (`stdio`:
critical, because it runs a program whose code is not in the package), a script takes the
highest risk of its tools, an automation is medium (it is created switched off).

### 4.2 Granting

- **All or nothing per version.** The review lists every permission and contribution of
  the version; approving it grants them, rejecting it grants nothing. (Optional, per-item
  permissions are a later addition; they need a plugin to cope with a refusal of each.)
- **Approving needs the password** (entered in the last 15 minutes, as for MCP servers and
  scripts), because it can give network access and unattended code. A device token can't
  approve.
- **An update never widens silently.** A new version is stored as *pending*; the plugin
  keeps running the approved version until the user approves the new one in the plugin's
  page, which shows the manifest diff, the added and removed permissions and the code diff.
- **Only the user approves.** An assistant can create a plugin and change its files; it can
  never approve a version, enable a plugin or grant a permission (§5).

### 4.3 What each permission maps to on the server

Every call a plugin makes is carried out as an existing **agent tool** call, through the
tool's own `actions()` and the policy engine, with the plugin as the actor. The permission
is what makes a tool allowed for that plugin:

| Permission | Tools it covers (for scripts' `tools` too) |
| --- | --- |
| `tasks:read` | `list_tasks`, `get_task`, `list_projects` |
| `tasks:write` | `create_task`, `update_task`, `delete_task` |
| `documents:read` | `list_documents`, `read_document`, `search_documents`, `list_properties` |
| `documents:write` | `write_document`, `edit_document`, `set_document_properties` |
| `events:read` | `list_events`, `get_event` |
| `events:write` | `create_event`, `update_event`, `delete_event` |
| `projects:read` | `list_projects` |
| `notifications:send` | `send_notification` |
| `network:<host>` | `http_request`, `read_web_page` (to that host only) |
| `tools:<name>` | `<name>` |

The policy a plugin call is evaluated with: **allow** what the approved permissions cover,
**ask** for critical capabilities, **deny** everything else, plus Anemo's fixed rules (paths
outside the workspace, settings and secrets). The user's *agent* permission levels don't
apply to plugin UI calls: they are about what models may do, and a plugin's grants were
decided by the user at review. A plugin **script** runs as a script automation and so goes
through the script path of spec 08 (its tool list, its hosts, the automation's permission
levels and `on_ask`), on top of these coverage rules.

## 5. Lifecycle

```
                        install (zip, Git, assistant, bundled example)
                                        │
                                        ▼
                          ┌──── needs review ─────┐  (version 1 pending; nothing runs)
            reject/discard│                       │ approve (password, package hash)
                          ▼                       ▼
                     (uninstalled)      enabled ◄──────► disabled      ← switch, any time
                                           │   ▲            │
                         new version ──────┘   │            │
                         (pending, old one     │ approve    │
                          keeps running)  ─────┘ (password) │
                                                            │
                     uninstall (keep or remove its data) ◄──┘ (from any state)

        kill switch (Settings → Plugins): every plugin stops at once, whatever its state
```

**Version states:** `pending` (stored, waiting for review), `approved` (the one that runs;
exactly one per plugin at most), `superseded` (approved earlier; can be approved again to
go back), `rejected` (the user discarded it; kept for the history, its files deleted).

**Plugin states** (derived, shown as badges): `needs_review` (no approved version yet),
`enabled`, `disabled`, plus the flags `update_pending` (a pending version newer than the
approved one), `error` (an approved version couldn't be registered or its files no longer
match their hash; the plugin is stopped and the message shown) and `made_by_assistant`.

| Event | What happens |
| --- | --- |
| Install | Files checked (§1) and stored; manifest validated; version 1 is `pending`; the plugin is disabled. Source recorded: `zip` (file name), `git` (URL, ref, commit), `assistant` (the chat), `bundled`. |
| Approve | Password confirmed; the request carries the package hash the user reviewed (a newer upload meanwhile → refused, 409). Contributions are created or updated to match the version, then it becomes `approved` (the previous one `superseded`). "Approve and enable" also switches the plugin on. |
| Enable / disable | Only a plugin with an approved version can be enabled. Disabled: no frame is shown, no call is answered, its commands and pages are hidden, its scripts and automations don't start (they are switched off and back on with it), its MCP servers are switched off. Its data stays. |
| Update | Like install, for the same `id` and a higher `version`: a new `pending` version. Same rules for every source; for an upload in the app the review screen is the next step, so it's one flow. |
| Assistant changes | Every change an assistant saves is a new `pending` version (consecutive unapproved changes replace the pending version rather than piling up). It never changes the approved version, and it never enables, approves or grants. |
| Uninstall | Choice: **keep its data** (the objects it created stay as the user's: properties, views, automations, scripts (switched off), profiles, skills; tasks, documents and events it wrote stay) or **remove its data** (the objects it registered are deleted; tasks, documents and events it created go to the trash; its storage is deleted). The confirmation lists what each choice affects. Files and versions are deleted either way. |
| Kill switch | One switch (`plugins.disabled_all`) that the host and the server both check before anything else: no frames, no calls, no commands, scripts and plugin MCP tools refused. It doesn't change each plugin's own switch, so turning it off restores the previous state. |

## 6. The host ⇄ plugin message API

### 6.1 The frame

Each UI contribution is shown in an `<iframe>` that Anemo creates:

- `sandbox="allow-scripts"` and nothing else: **no** `allow-same-origin` (the frame's origin
  is opaque, so it has no access to Anemo's cookies, storage or DOM, and Anemo's server sees
  its requests as cross-site: no cookie is sent), no forms, popups, top navigation, modals,
  downloads or pointer lock.
- The frame loads one fixed document from Anemo (`/api/plugin-frame`, the same for every
  plugin). Its response header is
  `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'sha256-<bootstrap>' blob:; style-src 'unsafe-inline' blob:; img-src data: blob:; font-src data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`,
  plus `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. The `sandbox`
  directive keeps the document sandboxed even if it is opened on its own; `connect-src`,
  `img-src` and friends mean **the frame can't reach any server**: not Anemo, not the web.
  `allow="..."` grants no features (camera, microphone, geolocation, clipboard…).
- The plugin's own files are not served to the frame. The **host** (Anemo's page) fetches
  the entry's HTML, scripts and styles with the user's session, checks them against the
  version's hashes, and hands them to the frame's bootstrap, which turns them into `blob:`
  URLs and loads them in order. So the frame needs no network and no credentials.
- What the frame shows is limited to its box. It can't draw over Anemo, open dialogs, read
  the clipboard, or navigate the app; it asks the host (`ui.*` methods).

### 6.2 The channel

1. The bootstrap posts `{"anemo": 1, "type": "hello"}` to its parent.
2. The host checks that `event.source` is the `contentWindow` of the frame it made (the
   origin is `"null"` for every sandboxed frame, so the source is what identifies it), then
   transfers a `MessagePort` with the `init` message:
   `{"anemo": 1, "type": "init", "plugin": {"id", "version"}, "slot", "ui": "<ui id>", "context": {…}, "theme": {…}, "locale": "en", "preview": false, "files": {…}}`.
3. From then on **everything goes over that port**. If the frame's document is replaced
   (it navigated), the new document doesn't have the port; the host also notices the second
   `load` event, removes the frame and reports it on the plugin's page.

Messages on the port (JSON only; at most 1 MB each):

```jsonc
// plugin → host: a request
{ "id": 7, "method": "tasks.list", "params": { "status": "todo" } }
// host → plugin: its answer, exactly one per request
{ "id": 7, "result": { … } }
{ "id": 7, "error": { "code": "permission_denied", "message": "This plugin may not read tasks." } }
// host → plugin: an event (no id)
{ "event": "theme.changed", "data": { … } }
```

The bootstrap wraps this in a small SDK available to the plugin as `window.anemo`:

```js
const { context, theme, plugin } = await anemo.ready      // the init data
const tasks = await anemo.call('tasks.list', { status: 'todo' })
anemo.on('context.changed', (ctx) => render(ctx))
anemo.ui.resize(320)                                       // short forms for the ui.* methods
```

### 6.3 Methods (version 1)

| Method | Params → result | Needs |
| --- | --- | --- |
| `context.get` | `{}` → the slot's `context` | – |
| `storage.get` / `storage.set` / `storage.delete` / `storage.list` | `{key}` / `{key, value}` / `{key}` / `{prefix?}` → value / `{}` / `{}` / `{keys}` | – (own storage: JSON values, keys ≤ 100 chars, 1 MB per plugin in total) |
| `tasks.list` | `{status?, projectId?, due?, query?, limit?}` → `{tasks: [Task]}` | `tasks:read` |
| `tasks.get` | `{id}` → `Task` | `tasks:read` |
| `tasks.create` / `tasks.update` | `{title, …}` / `{id, …changes}` → `Task` | `tasks:write` |
| `documents.list` / `documents.search` | `{folder?, projectId?, limit?}` / `{query, limit?}` → `{documents: [DocumentSummary]}` | `documents:read` |
| `documents.get` | `{id}` → `Document` (with `markdown`) | `documents:read` |
| `documents.create` / `documents.update` | `{path, markdown}` / `{id, markdown}` → `DocumentSummary` | `documents:write` |
| `events.list` | `{from, to}` → `{events: [Event]}` (recurring ones expanded) | `events:read` |
| `events.get` | `{id}` → `Event` | `events:read` |
| `events.create` / `events.update` | `{title, start, end, allDay?, …}` / `{id, …changes}` → `Event` | `events:write` |
| `projects.list` | `{}` → `{projects: [{id, name, color}]}` | `projects:read` |
| `notifications.send` | `{title, body?}` → `{}` | `notifications:send` |
| `http.fetch` | `{url, method?, headers?, body?}` → `{status, headers, body}` (text, ≤ 1 MB) | `network:<host of url>` |
| `tools.call` | `{name, args}` → `{content, data?, isError}` | `tools:<name>` |
| `scripts.run` | `{script, input?}` → `{runId}` (the result comes later in the run log) | the script is this plugin's |
| `templates.apply` | `{template}` → `{type, id}` of what was created | `documents:write` or `tasks:write` |
| `ui.resize` | `{height}` → `{}` (40–2000 px; panels and blocks only) | – |
| `ui.toast` | `{message, tone?}` → `{}` (plain text, ≤ 200 chars) | – |
| `ui.open` | `{type: "task"\|"document"\|"event"\|"page", id}` → `{}` (opens it in Anemo) | the matching `:read`, or own page |

The object shapes (`Task`, `DocumentSummary`, `Document`, `Event`) are plain JSON with
**camelCase** fields, ids as strings, times as ISO 8601; they are defined in the authoring
guide (`backend/app/features/plugins/guide.md`) and are **not** the internal API's models
(so the internal API can change). Fields are only ever added to them.

**Events** (host → plugin): `context.changed` (the panel's object or page params changed),
`theme.changed` (light/dark, accent, density), `object.changed` (`{type, id}`: the object the
panel shows was changed elsewhere; re-read it).

**Theme.** `init.theme` is `{mode, density, vars}`; `vars` are the values of Anemo's colour,
radius, font and density tokens (`--accent`, `--surface`, `--text`, `--muted`, `--border`,
`--card-x`, `--font-ui`…). The bootstrap sets them on the frame's `:root` and adds a small
base stylesheet (body font and colour, buttons, inputs, `.card`, `.muted`) so a plugin looks
native with no work. A plugin may style itself on top.

**Errors.** `code` is one of: `permission_denied`, `not_found`, `invalid_params`,
`declined` (the user said no to a confirmation), `rate_limited`, `unavailable` (the plugin
was disabled, the kill switch is on, or the server is unreachable), `failed` (the tool
returned an error; `message` says why), `unknown_method`.

### 6.4 Rules on every call

1. **Host check** (in the page): the plugin is enabled (or this is a preview), the kill
   switch is off, the method exists, the permission is in the approved manifest; at most
   120 requests per minute per frame and 8 in flight.
2. **Server check**: the same again against the version the server has approved (never
   what the page says), then the mapped tool's `actions()` go through the policy engine
   with the plugin's policy (§4.3), and the tool runs **as the actor
   `plugin:<id>@<version>`**. That reference is stored as `created_by`/`updated_by` on what
   it writes and shown as "the plugin Word count".
3. **Ask → the user confirms in Anemo's page.** A call that needs approval (critical
   capabilities; anything a tool's own risk rules make "ask") answers the host with
   `confirm_required` and a summary; the host shows Anemo's own dialog (never inside the
   frame), with the plugin's name and icon, what will happen, and Allow / Deny. Allow sends
   the call again with a one-time token bound to that exact call (2 minutes). The token
   never reaches the frame.
4. **Audit.** Every write, every confirmed call and every refused call is in the security
   log (`plugin.call` with plugin, version, method and outcome; never the data).
5. **Output is data.** Nothing a plugin returns, stores or renders becomes instructions for
   a model: plugin script results and plugin MCP tool results reach models only inside
   `<untrusted_data>` blocks, and when an agent tool reads a task, document or event that a
   plugin wrote last, the tool marks it as written by that plugin and wraps the
   plugin-written text as untrusted.

### 6.5 Preview

A version that is not approved (an assistant's draft, an update under review) can be tried
from the plugin's page in a **preview**: the same frame, `init.preview = true`, a banner in
Anemo's page around it ("Preview of version 1.1.0, not approved"). In a preview the
*read* permissions the draft asks for work (low risk), and every other call (writes,
notifications, network, tools) asks for confirmation each time. Scripts, automations and
other contributions of a draft are not created by a preview.

---

## 7. Internal: HTTP API (this round's agreement between workstreams; not plugin-facing)

All under `/api/plugins`, login required; *(re-auth)* = `RecentAuth`. `{plugin}` is the
manifest `id`.

| Route | Body → response | Notes |
| --- | --- | --- |
| `GET /api/plugins` | → `PluginListOut {plugins: [PluginOut], disabled_all}` | |
| `GET /api/plugins/{plugin}` | → `PluginDetailOut` | |
| `POST /api/plugins/install/zip` *(re-auth)* | multipart `file` → `PluginDetailOut` | new plugin or a new pending version |
| `POST /api/plugins/install/git` *(re-auth)* | `{url, ref?}` → `PluginDetailOut` | https only, public repositories, fetched without credentials through the guarded network rules |
| `GET /api/plugins/bundled` | → `{plugins: [BundledPluginOut]}` | the examples shipped with Anemo |
| `POST /api/plugins/install/bundled` *(re-auth)* | `{id}` → `PluginDetailOut` | |
| `PATCH /api/plugins/{plugin}` | `{enabled}` → `PluginOut` | enabling needs an approved version |
| `POST /api/plugins/{plugin}/versions/{version}/approve` *(re-auth)* | `{hash, enable}` → `PluginDetailOut` | 409 `plugin_changed` if `hash` isn't that version's |
| `DELETE /api/plugins/{plugin}/versions/{version}` | → 204 | reject a pending version |
| `GET /api/plugins/{plugin}/versions/{version}/diff` | `?against=<version>` (default: the approved one) → `PluginDiffOut` | |
| `GET /api/plugins/{plugin}/versions/{version}/files/{path}` | → the file (text as `text/plain; charset=utf-8`, images as their type) with `Content-Security-Policy: default-src 'none'`, `nosniff`, `X-Plugin-File-Sha256` | for the host and the code view |
| `GET /api/plugins/{plugin}/versions/{version}/ui/{ui}` | → `PluginFrameBundleOut {entry, html, scripts: [{path, text}], styles: [{path, text}], hash}` | what the host hands the frame |
| `GET /api/plugins/{plugin}/data` | → `PluginDataOut` | what it created and stores (for the uninstall choice) |
| `DELETE /api/plugins/{plugin}` | `?data=keep\|remove` → 204 | |
| `POST /api/plugins/{plugin}/call` | `{ui, method, params, confirm_token?, preview_version?}` → `{result}` or an error (`confirm_required` carries `details: {token, summary, risk}`) | §6.4 |
| `GET /api/plugins/contributions` | → `PluginContributionsOut {ui: [...], commands: [...], fences: [...], disabled_all}` | what the slots render; only enabled, approved versions |
| `POST /api/plugins/{plugin}/chat` | → `{conversation_id}` | "Continue building with the assistant"; C owns this route (`features/plugins/chat_router.py`, mounted next to A's router) |
| `GET /api/plugin-frame` | → the frame document (public, static, headers of §6.1) | |
| settings section `plugins` | `{disabled_all: bool}` | the kill switch; not sensitive (switching everything off must be quick) |

`PluginOut`: `id, name, description, version (approved or newest), icon_url|null, enabled,
status ("needs_review"|"enabled"|"disabled"|"error"), update_pending, made_by_assistant,
error|null, source {kind: "zip"|"git"|"assistant"|"bundled", label, url?, ref?, commit?,
conversation_ids}`, `ui_count`, `updated_at`.

`PluginDetailOut`: `PluginOut` plus `readme|null, author, license, approved_version|null,
pending_version|null, versions: [PluginVersionOut]`, `chats: [{id, title}]`.
`PluginVersionOut`: `version, status, hash, created_at, created_by (ActorOut), approved_at,
manifest, permissions: [PermissionOut], contributions: [ContributionOut], files: [{path,
size, sha256}]`. `PermissionOut`: `{name, kind, target|null, risk: "low"|"medium"|"high"|"critical",
label, explanation}`; `kind` is the part before the colon for `network`/`tools`
(`target` is the host or tool name) and the whole name otherwise. `label`/`explanation`
are the server's English text (used by the assistant's tools); the app shows its own
translated text per `kind` (and falls back to the server's for a kind it doesn't know). `ContributionOut`: `{kind, id, label, risk, detail}`.
`PluginDiffOut`: `{from, to, manifest: {before, after}, permissions: {added, removed, kept},
files: [{path, status: "added"|"removed"|"changed"|"same", before?, after?}]}` (text only;
binary files as `{status, sha256}`).

## 8. Internal: agent tools (workstream C)

Capability `plugins.build` (label "Build plugins", default **ask for dangerous actions**:
saving a draft is moderate and goes ahead; nothing a draft contains runs until the user
approves it). Reading is internal-allowed (`plugins.read`).

`plugin_guide` (the authoring guide and this contract's plugin-facing part), `plugin_list`,
`plugin_read` (manifest, files, status of one plugin, its pending diff), `plugin_validate`
(check a manifest and files without saving), `plugin_create` (a new plugin from files),
`plugin_update_files` (write or delete files of a plugin's pending version, starting from
the newest version), `plugin_preview` (a link to the preview of the pending version for the
user). None of them can approve, enable, grant or uninstall. Created plugins record the chat
(`source.conversation_ids`).

## 9. Ownership in this round

| Path | Owner |
| --- | --- |
| `backend/app/features/plugins/**` (models, service, manifest, package, permissions, calls, router, frame route, guide) , `backend/app/core/actor.py` (the `plugin` kind), `features/provenance/*`, `backend/migrations/versions/0079_plugins.py`, `backend/app/api/router.py` (one mount), settings section `plugins`, `backend/tests/**/test_plugins*.py`, `backend/app/features/plugins/bundled/` (the loader; the example packages in it are written in phase 2, A ships one tiny test package) | **A** (`feat/plugins-runtime`) |
| `frontend/src/features/plugins/**` (Settings → Plugins, cards, detail page, install, review, the host side of §6, slot components); the frame side of §6, `backend/app/features/plugins/frame/bootstrap.js` and `frame/base.css` (plain JS/CSS files that A's `/api/plugin-frame` route inlines), the slot mounts in `TaskDialog`, `DocumentInfo`, `EventDialog`, `Markdown`'s fence hook, `search/actions.ts` + `pages.ts`, `app/router.tsx`, `settings/sections.ts`, `src/locales/{uk,ru}/plugins.ts` | **B** (`feat/plugins-ui`) |
| `backend/app/tools/builtin/plugins.py`, its `policy/presets.py` entry, `tools/registry.py` entry, `backend/app/features/plugins/guide.md`, the "Continue building" chat setup (`POST …/chat` service), its tests | **C** (`feat/plugins-agent-tools`) |

A owns the service functions C calls, with exactly these signatures (in
`app/features/plugins/service.py` unless noted; none of them commits except where said):

```python
class PluginSource(BaseModel):  # schemas.py
    kind: Literal["zip", "git", "assistant", "bundled"]
    label: str
    url: str | None = None; ref: str | None = None; commit: str | None = None
    conversation_ids: list[str] = []

def validate_files(files: dict[str, bytes]) -> ValidationReport          # package.py, pure
    # ValidationReport(ok: bool, errors: list[ValidationIssue(path, message)], manifest: Manifest | None)
async def install_files(db, files: dict[str, bytes], *, source: PluginSource, by: str) -> PluginVersion
    # a new plugin (needs_review) or a new pending version of the same id; raises AppError
    # subclasses with code plugin_invalid (details.errors), plugin_version_not_higher
async def save_pending_files(db, plugin: Plugin, changes: dict[str, bytes | None], *, by: str) -> PluginVersion
    # starts from the pending version if there is one, else the newest; None deletes a file;
    # replaces the pending version; the result's version must be higher than the approved one
async def get_plugin(db, plugin_id: str) -> Plugin                       # NotFound "plugin_not_found"
async def list_plugins(db) -> list[Plugin]
async def version_files(db, plugin: Plugin, version: str) -> dict[str, bytes]
async def detail(db, plugin: Plugin) -> PluginDetailOut
async def diff(db, plugin: Plugin, version: str, against: str | None = None) -> PluginDiffOut
async def link_chat(db, plugin: Plugin, conversation_id: uuid.UUID) -> None
def permission_info(name: str) -> PermissionOut                          # permissions.py, pure
```

`by` is an actor reference (`user`, `chat:<id>`). C works in parallel with A: C codes
against these names, may keep a local, uncommitted stub to try its code, and its tests run
for real once A is merged (phase 2).
