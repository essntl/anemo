# Writing an Anemo plugin

A plugin adds things to Anemo: a panel on tasks, documents or events, a page, a renderer
for a kind of code block in chat answers, command-palette entries, and ready-made objects
Anemo already knows (properties, saved views, templates, automations, scripts, MCP
servers, agent profiles, skills, themes). This guide is the practical side of the plugin
contract (version 1); it is written for an assistant building a plugin inside Anemo and
for a person writing one by hand.

The rules that matter most:

- A plugin is a folder with `anemo-plugin.json` (the manifest) at its root.
- Everything a plugin may do at run time is a **permission** in its manifest. Without a
  permission it can show its UI, keep a little storage of its own and read its context.
- A new plugin, and every change to one, is saved as a **pending version**. Nothing in it
  runs until the user reviews and approves that exact version with their password. An
  assistant can create plugins and change their files; it can never approve, enable or
  grant anything.
- A change to a plugin that has an approved version needs a **higher `version`** in the
  manifest (semver: `1.0.0` → `1.0.1` for a fix, `1.1.0` for a feature).
- The UI runs in a sandboxed frame with **no network and no access to Anemo's page**. It
  talks to Anemo only through `window.anemo` (the SDK below).
- Unknown manifest fields, unknown permissions and missing files are errors, not ignored.

Sections (an assistant can ask `plugin_guide` for one by its key):

| Key | Section |
| --- | --- |
| `layout` | 1. The package |
| `manifest` | 2. The manifest |
| `contributions` | 3. Contributions |
| `slots` | 4. UI slots |
| `sdk` | 5. The frame SDK |
| `methods` | 6. Methods and object shapes |
| `permissions` | 7. Permissions and risk |
| `limits` | 8. What a frame can't do |
| `theme` | 9. Theme and base styles |
| `example` | 10. Example: a document panel |
| `errors` | 11. Common validation errors and fixes |
| `workflow` | 12. Building with the assistant's tools |

## 1. The package

```
word-count/
  anemo-plugin.json      the manifest (required)
  README.md              shown on the plugin's page (optional, Markdown)
  icon.png               the card icon (optional; PNG or WebP, square, at most 256 KB)
  ui/panel.html          a UI entry: HTML, plus the .js and .css files it references
  ui/panel.js
  ui/panel.css
  scripts/sync.ts        a script (runs in Anemo's Deno script sandbox)
  templates/meeting.md   a template body
```

| Rule | Limit |
| --- | --- |
| Files | at most 500 files, 5 MB in total, 1 MB per file |
| Paths | relative, `/`-separated, at most 200 characters; no `..` or `.` segments, no backslashes, no leading `/`, no names starting with `.` |
| File types | `.json .md .txt .html .css .js .mjs .ts .png .webp .woff2` only. No `.svg`, no executables, no `node_modules` |
| Text | UTF-8 |
| Pictures and fonts | checked by their content (a `.png` must really be a PNG) |

A zip may wrap everything in one top-level folder; it is removed on install.

Every version is stored with the SHA-256 of each file and a **package hash** over all of
them. The user approves that hash; the files are checked against it whenever they are
used.

## 2. The manifest

`anemo-plugin.json`, a complete example with every top-level field (comments are not
allowed in the real file; they are here to explain):

```jsonc
{
  "manifestVersion": 1,                 // always 1 for now
  "id": "artem.word-count",             // stable, unique, never changes (rules below)
  "version": "1.0.0",                   // semver; each new version must be higher
  "name": "Word count",                 // at most 40 characters
  "description": "Words, characters and reading time for the document you have open.", // at most 200
  "author": { "name": "Artem", "url": "https://example.com" },   // url is optional
  "license": "MIT",                     // optional, an SPDX id
  "icon": "icon.png",                   // optional, a file of the package
  "readme": "README.md",                // optional, a file of the package
  "permissions": ["documents:read"],    // section 7; may be empty
  "contributes": {                      // section 3; every key is optional
    "ui": [
      { "id": "panel", "slot": "object.panel", "objects": ["document"],
        "title": "Word count", "entry": "ui/panel.html", "height": 140 }
    ]
  }
}
```

**`id`**: lowercase letters, digits and `-`, in at least two parts separated by dots
(`^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$`), 3–64 characters. The first part names the
author (`artem.today-board`); `anemo.` is reserved for plugins shipped with Anemo. The id
is how Anemo recognises an update of the same plugin; it never changes, even when the
plugin is renamed.

**`version`**: `MAJOR.MINOR.PATCH`, optionally `-prerelease` (`1.2.0-beta.1`). A package
with the same id is an update only if its version is higher than every stored version.

**Item ids** inside `contributes` (`panel`, `today`, …): `^[a-z][a-z0-9-]{0,39}$`, unique
within their kind in this plugin.

Validation is strict: an unknown key anywhere is an error, every string has a length limit,
and every reference (a file, a script id, a template id, a property key used by a view)
must exist in the package.

## 3. Contributions

Everything a plugin adds goes under `contributes`. Declarative items (all but `ui`) become
real Anemo objects when the user approves the version, are updated when a later version is
approved, and belong to the plugin (removed or kept on uninstall, as the user chooses). The
user can see and change them in their usual place.

```jsonc
"contributes": {
  "ui": [ … ],                                         // section 4
  "properties": [
    { "id": "mood", "key": "mood", "label": "Mood", "type": "select",
      "appliesTo": ["document"], "options": ["good", "okay", "bad"] }
  ],
  "views": [
    { "id": "moods", "name": "Notes by mood", "layout": "board",
      "query": { "types": ["document"], "group_by": "mood" } }
  ],
  "templates": [
    { "id": "meeting", "kind": "document", "title": "Meeting notes", "file": "templates/meeting.md" },
    { "id": "review", "kind": "task", "title": "Weekly review",
      "task": { "title": "Weekly review", "priority": 2, "tags": ["review"],
                "checklist": ["Inbox to zero", "Plan next week"] } }
  ],
  "automations": [
    { "id": "morning", "name": "Morning summary",
      "prompt": "Summarise today's tasks and events in five lines.",
      "schedule": { "rrule": "FREQ=DAILY;BYHOUR=7;BYMINUTE=0" }, "tools": ["list_tasks", "list_events"] }
  ],
  "scripts": [
    { "id": "sync", "name": "Sync", "description": "Copies open tasks into a document.",
      "file": "scripts/sync.ts", "tools": ["list_tasks", "write_document"] }
  ],
  "mcpServers": [
    { "id": "weather", "name": "Weather", "transport": "http",
      "url": "https://mcp.weather.example.com/mcp", "headerNames": ["Authorization"] }
  ],
  "profiles": [
    { "id": "editor", "name": "Editor", "description": "Edits documents carefully.",
      "instructions": "You are a careful editor…", "skills": ["tighten"] }
  ],
  "skills": [
    { "id": "tighten", "name": "Tighten", "description": "Shortens a text.",
      "file": "skills/tighten.md", "userInvocable": true, "modelInvocable": false }
  ],
  "themes": [
    { "id": "forest", "name": "Forest", "appearance": { "mode": "dark", "accent": "#3f8f5a" } }
  ],
  "commands": [
    { "id": "open-board", "title": "Open Today board", "icon": "calendar-check",
      "keywords": ["today"], "action": { "type": "openPage", "page": "today" } },
    { "id": "run-sync", "title": "Sync tasks", "action": { "type": "runScript", "script": "sync" } },
    { "id": "new-meeting", "title": "New meeting notes",
      "action": { "type": "newFromTemplate", "template": "meeting" } }
  ]
}
```

| Kind | Notes |
| --- | --- |
| `properties` | `type`: `select multi_select text date number checkbox`; `appliesTo`: any of `document task event`. If the `key` exists with the same type the plugin uses it (and doesn't own it); a different type refuses the install. |
| `views` | `layout`: `list table board`; `query` as a saved view's query (types, text, properties, sort, group_by, columns). Its property keys must exist or be declared above. |
| `templates` | `kind: "document"` takes a Markdown `file` (front matter allowed); `kind: "task"` takes `task: {title, description?, priority?, tags?, checklist?}`. Used by commands and `templates.apply`. |
| `automations` | Created **switched off**; the user turns them on. `schedule` as for a schedule an assistant creates; `tools` is the tool allowlist. |
| `scripts` | TypeScript for Anemo's Deno sandbox (no network, no files); it acts only through tool calls. Its `tools` and `hosts` must be covered by the plugin's permissions (section 7). `schedule` defaults to manual. `secrets` are names; the user sets the values after install. |
| `mcpServers` | `transport`: `http`, `sse` (the URL's host needs a `network:` permission) or `stdio` (`command`, `args`; runs in the mcp-host container and is reviewed as critical). Header and env values are set by the user. Every tool of a plugin's server asks each time until the user changes that. |
| `profiles` | Name, description, instructions, optional `icon` and `skills` (of this plugin). No permission levels or limits: those stay the user's. |
| `skills` | `file` is the Markdown instructions; the slug is the `id` (an existing slug refuses the install). |
| `themes` | `appearance` is a subset of Settings → Appearance: `mode accent tint tintStrength uiFont codeFont glass glassStrength background` (`background`: `none` or `gradient`). Never applied automatically. |
| `commands` | Command-palette (Ctrl+K) entries. `action`: `openPage` (a `page` ui id), `runScript` (a script id, optional `input`), `newFromTemplate` (a template id). |

Static text in an approved version (skill and profile instructions, automation prompts) is
given to models as instructions; the user reviews it like code. Anything a plugin
**produces at run time** is treated as data, never as instructions.

Agent tools implemented by a plugin script don't exist in version 1: a plugin that wants
to give agents tools ships an MCP server.

## 4. UI slots

Each item of `contributes.ui` is one frame. `entry` is an HTML file of the package;
`title` is shown above it; `icon` is a lucide icon name (`calendar-check`, `book-open`…);
`height` is the starting height in CSS pixels (40–800).

| Slot | Where | `context` the frame gets | How many |
| --- | --- | --- | --- |
| `object.panel` | On a task (details column), a document (a tab of its side panel) or an event (below its fields); the kinds listed in `objects` | `{object: {type: "task"\|"document"\|"event", id}}` | any |
| `page` | A full page at `/plugins/<plugin id>/<ui id>`, listed under Plugins in the sidebar and in Ctrl+K | `{page: "<ui id>", params: {…query string}}` | any |
| `settings` | The Settings tab of the plugin's own page in Settings → Plugins | `{}` | at most 1 |
| `chat.block` | In a chat answer, instead of a fenced code block whose language is `fence` | `{block: {lang, text}}` | any |

```jsonc
"ui": [
  { "id": "panel", "slot": "object.panel", "objects": ["document", "task"],
    "title": "Word count", "entry": "ui/panel.html", "height": 140 },
  { "id": "today", "slot": "page", "title": "Today board", "icon": "calendar-check",
    "entry": "ui/today.html" },
  { "id": "settings", "slot": "settings", "entry": "ui/settings.html" },
  { "id": "kanban", "slot": "chat.block", "fence": "today-kanban", "entry": "ui/block.html" }
]
```

`fence`: `^[a-z][a-z0-9-]{2,39}$`; not `mermaid`, `chart` or `math` (Anemo draws those) and
not one another enabled plugin uses. A `chat.block` frame receives a model's output: treat
`context.block.text` as **untrusted input** (parse it defensively, never `eval` it, escape it
before showing it as HTML).

## 5. The frame SDK

Anemo loads the entry HTML into a sandboxed frame together with the `.js` and `.css` files
it references by relative path (`<script src="panel.js"></script>`,
`<link rel="stylesheet" href="panel.css">`). Scripts run in document order. There is no
module loader and no network: put everything the UI needs into the package (a small
library can be copied in as a `.js` file).

The SDK is the global `window.anemo`:

```js
const { plugin, slot, ui, context, theme, locale, preview } = await anemo.ready
// plugin: {id, version}; slot: "object.panel" | "page" | "settings" | "chat.block"
// ui: the ui item's id; context: see section 4; theme: section 9
// locale: "en" | "uk" | "ru"; preview: true while the user previews an unapproved version

const result = await anemo.call('tasks.list', { status: 'todo' })   // any method of section 6
anemo.on('context.changed', (ctx) => render(ctx))                    // events, below

anemo.ui.resize(320)                       // = anemo.call('ui.resize', {height: 320})
anemo.ui.toast('Saved', 'success')         // = anemo.call('ui.toast', {message, tone})
anemo.ui.open('document', id)              // = anemo.call('ui.open', {type, id})

await anemo.storage.set('lastTab', 'stats')   // the plugin's own storage (JSON values)
const tab = await anemo.storage.get('lastTab')   // the value, or null
await anemo.storage.delete('lastTab')
const { keys } = await anemo.storage.list('last')   // keys starting with a prefix
```

`anemo.call` returns a promise of the method's result. A failed call rejects with an
`Error` that has a `code`:

| Code | Meaning |
| --- | --- |
| `permission_denied` | the plugin's approved manifest doesn't have the permission |
| `not_found` | the object doesn't exist (or was deleted) |
| `invalid_params` | the params don't match the method |
| `declined` | the user said no to a confirmation |
| `rate_limited` | more than 120 calls a minute, or more than 8 at once |
| `unavailable` | the plugin is disabled, the kill switch is on, or the server is unreachable |
| `failed` | the underlying action failed; `message` says why |
| `unknown_method` | no such method in this Anemo version |

```js
try {
  await anemo.call('tasks.update', { id, status: 'done' })
} catch (err) {
  anemo.ui.toast(err.code === 'declined' ? 'Not changed' : err.message, 'error')
}
```

**Events** (`anemo.on(name, handler)`):

| Event | Data | When |
| --- | --- | --- |
| `context.changed` | the new `context` | the panel now shows another object, or the page's params changed |
| `theme.changed` | the new `theme` | light/dark, accent or density changed (the variables are already updated) |
| `object.changed` | `{type, id}` | the object the panel shows was changed elsewhere: read it again |

## 6. Methods and object shapes

Params and results are JSON. Fields are **camelCase**, ids are strings, times are ISO 8601
(`2026-11-25T09:30:00+01:00`), dates `YYYY-MM-DD`. Optional params can be left out.

| Method | Params → result | Needs |
| --- | --- | --- |
| `context.get` | `{}` → the slot's `context` | – |
| `storage.get` | `{key}` → the value or `null` | – |
| `storage.set` | `{key, value}` → `{}` | – |
| `storage.delete` | `{key}` → `{}` | – |
| `storage.list` | `{prefix?}` → `{keys: [string]}` | – |
| `tasks.list` | `{status?, projectId?, due?, query?, limit?}` → `{tasks: [Task]}` | `tasks:read` |
| `tasks.get` | `{id}` → `Task` | `tasks:read` |
| `tasks.create` | `{title, description?, status?, priority?, due?, dueTime?, tags?, projectId?, checklist?}` → `Task` | `tasks:write` |
| `tasks.update` | `{id, …the fields to change}` → `Task` | `tasks:write` |
| `documents.list` | `{folder?, projectId?, limit?}` → `{documents: [DocumentSummary]}` | `documents:read` |
| `documents.search` | `{query, limit?}` → `{documents: [DocumentSummary]}` | `documents:read` |
| `documents.get` | `{id}` → `Document` | `documents:read` |
| `documents.create` | `{path, markdown}` → `DocumentSummary` | `documents:write` |
| `documents.update` | `{id, markdown}` → `DocumentSummary` | `documents:write` |
| `events.list` | `{from, to}` (dates or times) → `{events: [Event]}`, repeating events expanded | `events:read` |
| `events.get` | `{id}` → `Event` | `events:read` |
| `events.create` | `{title, start, end, allDay?, description?, location?}` → `Event` | `events:write` |
| `events.update` | `{id, …the fields to change}` → `Event` | `events:write` |
| `projects.list` | `{}` → `{projects: [{id, name, color}]}` | `projects:read` |
| `notifications.send` | `{title, body?}` → `{}` | `notifications:send` |
| `http.fetch` | `{url, method?, headers?, body?}` → `{status, headers, body}` (body as text, at most 1 MB) | `network:<host of url>` |
| `tools.call` | `{name, args}` → `{content, data?, isError}` | `tools:<name>` |
| `scripts.run` | `{script, input?}` → `{runId}` (the result is in the run log later) | the script is this plugin's |
| `templates.apply` | `{template}` → `{type, id}` of what was created | `documents:write` or `tasks:write` |
| `ui.resize` | `{height}` → `{}` (40–2000; panels and blocks) | – |
| `ui.toast` | `{message, tone?}` → `{}` (plain text, at most 200 characters; tone `info success warning error`) | – |
| `ui.open` | `{type: "task"\|"document"\|"event"\|"page", id}` → `{}` | the matching `:read`, or a page of this plugin |

Storage: keys at most 100 characters, JSON values, 1 MB per plugin in total.

### Task

```jsonc
{
  "id": "0193b0c2-…",
  "title": "Write the report",
  "description": "Markdown",
  "status": "todo",              // todo | in_progress | waiting | blocked | done | cancelled
  "priority": 0,                 // 0 none, 1 low, 2 medium, 3 high
  "due": "2026-11-27",           // date or null
  "dueTime": "14:00",            // HH:MM or null (only with due)
  "tags": ["work"],
  "projectId": "0193…",          // or null
  "parentId": null,              // the parent task of a subtask
  "checklist": [{ "id": "a1b2c3d4", "text": "Outline", "done": true }],
  "completedAt": null,           // ISO time or null
  "createdAt": "2026-11-20T08:00:00Z",
  "updatedAt": "2026-11-24T17:12:03Z"
}
```

### DocumentSummary and Document

```jsonc
// DocumentSummary
{
  "id": "0193…",
  "path": "documents/notes/idea.md",   // where it is in the workspace
  "title": "Idea",
  "folder": "notes",                   // inside documents/; "" for the top level
  "wordCount": 412,
  "updatedAt": "2026-11-24T17:12:03Z"
}
// Document = DocumentSummary plus
{
  "markdown": "# Idea\n\nThe whole text, front matter included."
}
```

### Event

```jsonc
{
  "id": "0193…",                 // for an expanded repeating event: the same id for every occurrence
  "title": "Dentist",
  "description": "",
  "location": "",
  "start": "2026-11-27T09:30:00+01:00",
  "end": "2026-11-27T10:15:00+01:00",
  "allDay": false,               // all-day events: start and end are dates, end inclusive
  "projectId": null,
  "repeats": false               // true for an occurrence of a repeating event
}
```

Fields are only ever **added** to these shapes, so ignore fields you don't know.

## 7. Permissions and risk

| Permission | Allows | Risk |
| --- | --- | --- |
| `tasks:read` | list and read tasks (and their projects) | low |
| `documents:read` | list, search and read documents | low |
| `events:read` | list and read calendar events | low |
| `projects:read` | list projects | low |
| `tasks:write` | create and change tasks | medium |
| `documents:write` | create and change documents | medium |
| `events:write` | create and change events | medium |
| `notifications:send` | send the user a notification | high |
| `network:<host>` | `http.fetch` to that host (`network:*.example.com` = its subdomains) | high |
| `tools:<tool name>` | call that agent tool (built-in, or `mcp__<server>__<tool>`) | high, or critical |

**Critical** are tools that control a device, a shell or a computer (`shell.*`,
`computer.*`, `browser.*`, `code.run`, `agent.spawn`, `focus.control`, `voice.control`): they
can be granted, but every single call asks the user. Settings and secrets can't be reached by
plugins at all.

Ask for as little as possible: the review shows each permission with its risk, and read
permissions carry the warning that what a plugin can read, it could send out. UI slots
need no permission (they are shown as low risk).

What scripts may call is limited by the same permissions: a script's `tools` must be
covered (`tasks:read` covers `list_tasks`, `get_task`, `list_projects`; `tasks:write`
covers `create_task`, `update_task`, `delete_task`; `documents:read` covers
`list_documents`, `read_document`, `search_documents`, `list_properties`;
`documents:write` covers `write_document`, `edit_document`, `set_document_properties`;
`events:read` covers `list_events`, `get_event`; `events:write` covers `create_event`,
`update_event`, `delete_event`; `notifications:send` covers `send_notification`;
`network:<host>` covers `http_request` and `read_web_page` to that host; `tools:<name>`
covers that tool), and its `hosts` need matching `network:` permissions.

Calls run as the plugin (`plugin:<id>@<version>`): what it writes shows "the plugin Word
count" as its author, and every write is in the security log.

**Preview.** While the user previews an unapproved version (`preview: true`), the read
permissions it asks for work; every other call (writes, notifications, network, tools)
asks for confirmation each time. Contributions of a draft are not created by a preview.

## 8. What a frame can't do

The frame is `sandbox="allow-scripts"` with an opaque origin and a strict Content Security
Policy. In practice:

- **No network.** `fetch`, `XMLHttpRequest`, WebSockets, `<img src="https://…">`, web
  fonts from a CDN and `<script src="https://…">` all fail. Use `http.fetch` with a
  `network:<host>` permission; the server makes the request.
- **No Anemo session.** No cookies, no `localStorage`/`sessionStorage`/IndexedDB of Anemo.
  Use `anemo.storage`.
- **No dialogs, popups or navigation.** `alert`, `confirm`, `window.open`, forms that submit
  and links that navigate don't work (a frame that navigates is removed). Use `ui.toast`,
  `ui.open`, and your own in-frame UI.
- **Only its own box.** It can't draw over Anemo or read the clipboard; it can ask for a
  different height with `ui.resize`.
- **Images and fonts** must be in the package or made in the page (`data:`/`blob:` URLs).
  `.svg` files aren't allowed; inline `<svg>` elements in the HTML are fine.
- No `eval` of remote code is possible anyway; don't `eval` data either.

## 9. Theme and base styles

`theme` is `{mode: "light"|"dark", density, vars}`. The `vars` are already set on the
frame's `:root`, so CSS can use them directly; they change with `theme.changed`.

| Variable | Use |
| --- | --- |
| `--bg`, `--surface`, `--surface-2`, `--card` | backgrounds, from the page to raised cards |
| `--text`, `--muted`, `--subtle` | text, secondary text, hints |
| `--border` | lines and outlines |
| `--accent`, `--accent-contrast` | the user's accent colour and text on it |
| `--success`, `--warning`, `--error` | states |
| `--radius-card`, `--radius-control` | corner radii |
| `--card-x` | horizontal padding of a card at the current density |
| `--font-ui`, `--font-mono` | the user's fonts |

A small base stylesheet is added before the plugin's own CSS: the body uses the UI font,
text colour and a transparent background; `button`, `input`, `select` and `textarea` look
like Anemo's controls; `.card` is a card, `.muted` is secondary text. Style on top of it
with your own CSS, using the variables instead of fixed colours so light and dark both
work.

## 10. Example: a document panel

A complete plugin that shows word count and reading time on every document.

`anemo-plugin.json`

```json
{
  "manifestVersion": 1,
  "id": "artem.word-count",
  "version": "1.0.0",
  "name": "Word count",
  "description": "Words, characters and reading time for the document you have open.",
  "author": { "name": "Artem" },
  "permissions": ["documents:read"],
  "contributes": {
    "ui": [
      { "id": "panel", "slot": "object.panel", "objects": ["document"],
        "title": "Word count", "entry": "ui/panel.html", "height": 120 }
    ]
  }
}
```

`ui/panel.html`

```html
<!doctype html>
<html>
  <head>
    <link rel="stylesheet" href="panel.css">
  </head>
  <body>
    <div class="card">
      <div class="stats">
        <div><b id="words">–</b><span class="muted">words</span></div>
        <div><b id="chars">–</b><span class="muted">characters</span></div>
        <div><b id="minutes">–</b><span class="muted">min read</span></div>
      </div>
    </div>
    <script src="panel.js"></script>
  </body>
</html>
```

`ui/panel.css`

```css
.stats { display: flex; gap: 16px; }
.stats div { display: flex; flex-direction: column; }
.stats b { font-size: 20px; color: var(--text); }
```

`ui/panel.js`

```js
function count(markdown) {
  const text = markdown.replace(/^---[\s\S]*?---/, '')   // leave out the front matter
  const words = text.split(/\s+/).filter(Boolean).length
  return { words, chars: text.length, minutes: Math.max(1, Math.round(words / 220)) }
}

async function render(context) {
  const doc = await anemo.call('documents.get', { id: context.object.id })
  const c = count(doc.markdown)
  document.getElementById('words').textContent = c.words
  document.getElementById('chars').textContent = c.chars
  document.getElementById('minutes').textContent = c.minutes
}

anemo.ready.then(({ context }) => render(context))
anemo.on('context.changed', render)
anemo.on('object.changed', async () => render(await anemo.call('context.get', {})))
```

Note `textContent` (not `innerHTML`): document text is shown as text, never as HTML.

## 11. Common validation errors and fixes

| Error | Fix |
| --- | --- |
| `anemo-plugin.json` is missing | The manifest must be at the package root, with exactly that name. |
| Not valid JSON | No comments, no trailing commas, double quotes only. |
| Unknown field `x` | Remove it, or check its spelling and place (e.g. `objects` belongs to a `ui` item, not to `contributes`). Fields are camelCase (`manifestVersion`, `appliesTo`). |
| Invalid `id` | Lowercase, at least two dot-separated parts: `yourname.plugin-name`. Don't use `anemo.`. |
| Invalid `version` / not higher | Use `MAJOR.MINOR.PATCH`; after an approval every change needs a higher version than every stored one. |
| Unknown permission | Use one of section 7; `network:` needs a host (`network:api.example.com`), `tools:` a tool name. |
| A referenced file doesn't exist | `entry`, `icon`, `readme`, template and script `file`s must be paths inside the package, exactly as written (case matters). |
| File type not allowed | Only `.json .md .txt .html .css .js .mjs .ts .png .webp .woff2`. Convert an `.svg` icon to PNG or inline it in the HTML. |
| Path not allowed | Relative, `/`, no `..`, no leading `/`, no hidden names (`.env`, `.gitignore`). |
| File too large / too many files | At most 1 MB per file, 5 MB and 500 files in total. Remove bundled libraries you don't need. |
| A picture doesn't match its type | The bytes of `icon.png` must be a real PNG (send binary files as base64, see section 12). |
| `slot` unknown / `objects` missing | Slots: `object.panel` (needs `objects`), `page`, `settings` (at most one), `chat.block` (needs `fence`). |
| `fence` taken | Another enabled plugin uses it, or it is `mermaid`/`chart`/`math`: pick another name. |
| A script's tool isn't covered | Add the permission that covers it (section 7) or remove the tool from the script's `tools`. |
| A view uses an unknown property | Declare the property under `properties`, or use a key that exists. |
| Duplicate item id | Item ids must be unique within their kind (two `ui` items can't both be `panel`). |

## 12. Building with the assistant's tools

An assistant in Agent mode builds plugins with these tools:

| Tool | What it does |
| --- | --- |
| `plugin_guide` | this guide, or one section of it |
| `plugin_list` | the installed plugins with their state |
| `plugin_read` | one plugin: manifest, state, files, chosen file contents, the changes waiting for review |
| `plugin_validate` | checks a package without saving it |
| `plugin_create` | saves a new plugin from files (a pending version; the plugin stays off) |
| `plugin_update_files` | writes or deletes files; the result is a new pending version |
| `plugin_preview` | a link where the user can try the pending version |

Files are given as `{"path": "text"}`. Binary files (`.png`, `.webp`, `.woff2`) are given
as base64 with the prefix `base64:` (`{"icon.png": "base64:iVBORw0KGgo…"}`); text files are
always taken literally.

A good way to work:

1. Read the relevant sections of this guide (`manifest`, `slots`, `methods`, `example`).
2. Ask for the fewest permissions that do the job.
3. `plugin_validate` the files, fix every listed problem, then `plugin_create`.
4. Give the user the `plugin_preview` link and tell them the plugin needs their review in
   Settings → Plugins before it runs. You can't approve or enable it.
5. For changes, `plugin_read` first, then `plugin_update_files` with only the files that
   change. If the plugin has an approved version, raise `version` in the manifest.
