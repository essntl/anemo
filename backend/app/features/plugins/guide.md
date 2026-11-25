# Writing an Anemo plugin

A plugin adds things to Anemo: a panel on tasks, documents or events, a page, a tab on
the Code page, a renderer for a kind of code block in chat answers, a click-through layer
over the window (an overlay), command-palette entries, and ready-made objects
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
  sprites/idle.gif       a picture the UI shows (PNG, WebP, GIF or JPEG)
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
| File types | `.json .md .txt .html .css .js .mjs .ts .png .webp .gif .jpg .jpeg .woff2` only. No `.svg`, no executables, no `node_modules` |
| Text | UTF-8 |
| Pictures and fonts | checked by their content (a `.png` must really be a PNG, a `.gif` a GIF, a `.jpg` a JPEG); the icon stays PNG or WebP |

A zip may wrap everything in one top-level folder; it is removed on install. A plugin
installed from a **Git** repository (https, public) must have `anemo-plugin.json` at the
repository's root; hidden entries (names starting with a dot: `.git`, `.github`,
`.gitignore`…) are skipped, so they don't break the path rules.

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
author (`artem.today-board`); ids starting with `anemo.` are reserved for the plugins
shipped with Anemo (bundled) and are refused from any other source. The id
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
      "action": { "type": "newFromTemplate", "template": "meeting" } },
    { "id": "toggle-layer", "title": "Clock: show or hide",
      "action": { "type": "sendToUi", "ui": "layer", "event": "toggle" } }
  ]
}
```

| Kind | Notes |
| --- | --- |
| `properties` | `type`: `select multi_select text date number checkbox`; `appliesTo`: any of `document task event`. If the `key` exists with the same type the plugin uses it (and doesn't own it); a different type refuses the install. |
| `views` | `layout`: `list table board` (default `list`); `query` is a saved view's query and its keys are the saved view's own, **snake_case**: `{types?, text?, properties?, sort?: [{key, desc?}], group_by?, columns?}` (`types` defaults to `["document"]`). Its property keys must exist or be declared above. |
| `templates` | `kind: "document"` takes a Markdown `file` (front matter allowed); `kind: "task"` takes `task: {title, description?, priority?, tags?, checklist?}`. Used by commands and `templates.apply`. In version 1 a template is copied as it is: no placeholders (date, week), and a document template always becomes `documents/<the title as a file name>.md`. A plugin that needs a computed name or text uses a script instead. |
| `automations` | Created **switched off**; the user turns them on. `schedule` is required: `{rrule?, at?}` (at least one; `rrule` an RFC 5545 rule such as `FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0`, repeating from `at` or from now; `at` an ISO time, for once; in the user's time zone). `tools` is the tool allowlist. |
| `scripts` | TypeScript for Anemo's Deno sandbox (no network, no files); it acts only through tool calls. Its `tools` and `hosts` must be covered by the plugin's permissions (section 7). `schedule` is `"manual"` (the default: started by a command, the plugin's UI or the user) or `{rrule?, at?}` as for automations. `thinkTools` lists tools it may use while thinking. `secrets` are names; the user sets the values after install. A plugin's script acts on **the permissions the user granted the plugin**, not on the agent permission levels: what its permissions cover goes ahead, a tool's own dangerous actions (deleting…) and critical tools (shell, devices…) ask, anything else is refused. **Use `await anemo.api(method, params)` for data**: the plugin's methods of section 6 (all but `context.get`, `ui.*`, `tools.call`, `http.fetch`, `scripts.run`), with the same JSON shapes; a refusal throws a `PluginError` whose `code` is the error code (`exists`, `permission_denied`, … and `needs_approval` for a call that would need the user's confirmation). A script needs no `tools` for these. `anemo.call(tool, args)` remains for tools that have no method (its result is text written for models: don't parse it). The input has `timeZone`, the user's time zone. |
| `mcpServers` | `transport`: `http`, `sse` (the URL's host needs a `network:` permission) or `stdio` (`command`, `args`; runs in the mcp-host container and is reviewed as critical). Header and env values are set by the user. Every tool of a plugin's server asks each time until the user changes that. |
| `profiles` | Name, description, instructions, optional `icon` and `skills` (of this plugin). No permission levels or limits: those stay the user's. |
| `skills` | `file` is the Markdown instructions; the slug is the `id` (an existing slug refuses the install). |
| `themes` | `appearance` is a subset of Settings → Appearance: `mode accent tint tintStrength uiFont codeFont glass glassStrength background` (`background`: `none` or `gradient`). Never applied automatically. |
| `commands` | Command-palette (Ctrl+K) entries. `action`: `openPage` (a `page` ui id), `runScript` (a script id, optional `input`), `newFromTemplate` (a template id), `sendToUi` (a `ui` id of this plugin and an `event` name, 1–40 letters, digits, `_ . : -`): the open frame of that UI gets `anemo.on('command', {event})`; if it isn't open, Anemo says so in a toast and nothing else happens. |

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
| `overlay` | A transparent layer over Anemo's whole window, for the whole session (it stays across pages) | `{overlay: true}` | at most 1 |
| `code.panel` | A tab beside the job on the Code page, for the project of the job the user has open | `{code: {device, project, jobId}}` | any |

```jsonc
"ui": [
  { "id": "panel", "slot": "object.panel", "objects": ["document", "task"],
    "title": "Word count", "entry": "ui/panel.html", "height": 140 },
  { "id": "today", "slot": "page", "title": "Today board", "icon": "calendar-check",
    "entry": "ui/today.html" },
  { "id": "settings", "slot": "settings", "entry": "ui/settings.html" },
  { "id": "kanban", "slot": "chat.block", "fence": "today-kanban", "entry": "ui/block.html" },
  { "id": "layer", "slot": "overlay", "title": "Clock", "entry": "ui/layer.html" },
  { "id": "graph", "slot": "code.panel", "title": "Git graph", "icon": "git-branch",
    "entry": "ui/graph.html" }
]
```

`fence`: `^[a-z][a-z0-9-]{2,39}$`; not `mermaid`, `chart` or `math` (Anemo draws those) and
not one another enabled plugin uses. A `chat.block` frame receives a model's output: treat
`context.block.text` as **untrusted input** (parse it defensively, never `eval` it, escape it
before showing it as HTML).

### Overlays

An `overlay` is one frame the size of the window, drawn over Anemo's pages. `title` is
optional (the review shows it); `height` and `icon` don't apply. Because a layer over the
whole window could imitate Anemo, Anemo holds it to these rules:

- **Click-through.** Every click, scroll and hover goes to Anemo underneath, except inside
  the rectangles the overlay names with `ui.setHitRegions` (at most 8, each at most
  320 × 320 pixels). With no regions it is fully click-through. On touch screens an
  overlay is always click-through in version 1.
- **Below Anemo's own things.** Dialogs, confirmations, the password prompt, a plugin
  call's Allow/Deny, toasts and the command palette are always above it, and the overlay
  is **hidden** while any dialog, the opened Dynamic Island or a plugin review is on
  screen. It comes back when they close.
- **No keyboard focus from Tab**, and it only gets keys after the user clicks inside one
  of its regions.
- **The user can hide every overlay** from Ctrl+K ("Hide plugin overlays", remembered on
  that device), and the review shows an overlay as **medium** risk ("Draws over Anemo's
  window"). An update that adds an overlay always waits for a review.
- An overlay can't be tried in a preview: it runs once its version is approved.

The overlay hides and shows itself with `ui.setVisible`. To place something beside the
message box or the sidebar, read `layout.get` and follow `layout.changed` (section 5).

### Code panels

A `code.panel` is a tab on the Code page, next to the job view (labelled with its `title`,
which it must have, and its `icon`). It fills its box like a page; `ui.resize` and
`height` don't apply. The tabs are only there while a job is open: the job says which
computer and project the panel is about.

`context.code` is `{device, project, jobId}`: the computer's name (as in Settings >
Devices), the project's folder name in that computer's projects folder, and the open job's
id (`null` when there is none). When the user opens another job the frame stays and gets
`context.changed`; it isn't reloaded. Whenever a Claude Code job of that project changes
state the panel gets `code.job` (section 5), so it can read the project again after a job
committed something. In a preview on the plugin's own page `device` and `project` are
`null`.

To read the project, ask for `code:read` (section 7) and call `code.gitGraph` and
`code.gitCommit` (section 6). Anemo's server asks Anemo Desktop on that computer, which runs
a fixed set of read-only git commands: no shell, no file contents, no diffs. The computer
must be a trusted one that shares its Claude Code jobs, online, with Anemo Desktop 1.5.0 or
later; otherwise the call fails with `unavailable` and a message that says why. (Anemo has
its own Git view on the Code page; a panel is for something else you want to show.)

A panel that lists the current branch and the last commits (inline, for the idea):

```html
<!-- ui/graph.html -->
<div class="stack">
  <div class="row"><b id="head">…</b><span id="dirty" class="badge"></span></div>
  <ul id="commits" class="list"></ul>
</div>
<script>
  async function render({ code }) {
    if (!code.device) return                       // a preview: no project
    try {
      const graph = await anemo.call('code.gitGraph', { device: code.device, project: code.project, limit: 50 })
      const head = graph.head
      document.getElementById('head').textContent = head.detached ? 'detached at ' + head.commit.slice(0, 7) : (head.branch ?? '')
      document.getElementById('dirty').textContent = graph.status?.dirty ? 'uncommitted changes' : 'clean'
      const list = document.getElementById('commits')
      list.replaceChildren(...graph.commits.map((c) => {
        const li = document.createElement('li')
        li.textContent = c.hash.slice(0, 7) + ' ' + c.subject + (c.refs.length ? '  (' + c.refs.join(', ') + ')' : '')
        return li
      }))
    } catch (err) {
      anemo.ui.toast(err.message, 'error')         // e.g. unavailable: the computer is offline
    }
  }
  anemo.ready.then(({ context }) => render(context))
  anemo.on('context.changed', render)
  anemo.on('code.job', async ({ state }) => {     // a job of this project changed state
    if (state !== 'running') render(await anemo.call('context.get', {}))
  })
</script>
```

Commit subjects, branch names and author names are text from the repository: show them
with `textContent`, never as HTML.

A small overlay that keeps a clock above the message box (inline, for the idea):

```html
<!-- ui/layer.html -->
<div id="clock" class="badge" style="position: fixed; display: none"></div>
<script>
  const clock = document.getElementById('clock')
  let shown = true
  function place({ anchors }) {
    const box = anchors.composer             // only there while a chat is on screen
    clock.style.display = box && shown ? 'block' : 'none'
    if (!box) return anemo.ui.setHitRegions([])
    const r = { x: box.x + box.width - 90, y: box.y - 34, width: 90, height: 28 }
    Object.assign(clock.style, { left: r.x + 'px', top: r.y + 'px' })
    anemo.ui.setHitRegions(shown ? [r] : [])   // only the clock takes clicks
  }
  clock.addEventListener('click', () => anemo.ui.toast(new Date().toLocaleString()))
  setInterval(() => { clock.textContent = new Date().toLocaleTimeString() }, 1000)
  anemo.ready.then(({ layout }) => place(layout))
  anemo.on('layout.changed', place)
  anemo.on('command', async ({ event }) => {  // the sendToUi command of section 3
    if (event === 'toggle') { shown = !shown; place(await anemo.layout.get()) }
  })
</script>
```

## 5. The frame SDK

Anemo loads the entry HTML into a sandboxed frame together with the `.js` and `.css` files
it references by relative path (`<script src="panel.js"></script>`,
`<link rel="stylesheet" href="panel.css">`). Scripts run in document order, and only the
ones the HTML names run. A `<script type="module">` may import other `.js`/`.mjs` files of
the package by a relative path (`import { count } from './count.js'`); every script of the
version is handed to the frame for that. Imports in a circle and bare names
(`import 'lodash'`) don't work. There is no network: put everything the UI needs into the
package (a small library can be copied in as a `.js` file).

The SDK is the global `window.anemo`:

```js
const { plugin, slot, ui, context, theme, locale, timeZone, preview, layout } = await anemo.ready
// plugin: {id, version}; slot: "object.panel" | "page" | "settings" | "chat.block" | "overlay" | "code.panel"
// ui: the ui item's id; context: see section 4; theme: section 9
// locale: "en" | "uk" | "ru"; timeZone: the user's IANA zone (Settings > General), use it
// for "today" so you ask the server for the same day it means; preview: true while the user previews an unapproved version
// layout: where things are on screen, as layout.get returns it (below)

const result = await anemo.call('tasks.list', { status: 'todo' })   // any method of section 6
anemo.on('context.changed', (ctx) => render(ctx))                    // events, below

const stop = anemo.on('theme.changed', (theme) => {})   // anemo.on returns a function that stops listening

anemo.ui.resize(320)                       // = anemo.call('ui.resize', {height: 320})

// Fit a panel to its content, growing and shrinking. Measure the body, not
// document.documentElement.scrollHeight: that is never less than the frame's own height,
// so a panel measured that way can grow but never shrink.
new ResizeObserver(() => anemo.ui.resize(Math.ceil(document.body.getBoundingClientRect().height))).observe(document.body)
anemo.ui.toast('Saved', 'success')         // = anemo.call('ui.toast', {message, tone})
anemo.ui.open('document', id)              // = anemo.call('ui.open', {type, id})

await anemo.storage.set('lastTab', 'stats')        // = anemo.call('storage.set', {key, value}); JSON values
const tab = await anemo.storage.get('lastTab')     // = anemo.call('storage.get', {key}): the value, or null
await anemo.storage.delete('lastTab')              // = anemo.call('storage.delete', {key})
const { keys } = await anemo.storage.list('last')  // = anemo.call('storage.list', {prefix}); no argument: every key

// Pictures: the package's own, and larger ones the plugin keeps (25 MB in all)
img.src = anemo.files.url('sprites/idle.gif')     // a package picture as a data: URL (null if there is none)
const file = await anemo.ui.pickFile({ accept: ['image/gif', 'image/png'] })  // call it from a click handler
await anemo.assets.set('sprite', file.dataUrl)     // = anemo.call('assets.set', {key, dataUrl})
const saved = await anemo.assets.get('sprite')     // {dataUrl} or null
const { assets } = await anemo.assets.list()       // [{key, type, size}]
await anemo.assets.delete('sprite')

// Where things are, and an overlay's own controls
const { viewport, anchors, route } = await anemo.layout.get()   // = anemo.call('layout.get', {})
anemo.ui.setHitRegions([{ x: 20, y: 600, width: 96, height: 96 }])  // overlay only
anemo.ui.setVisible(false)                                          // overlay only
```

`<img src="…">` in the entry's HTML and `url(…)` in its stylesheets may name pictures of
the package by a relative path: Anemo puts them in as `data:` URLs (the frame can't fetch
files). In script, use `anemo.files.url(path)` with a path from the package root.

`context.get`, `layout.get` and the `ui.*` methods are answered by Anemo's page itself (it
knows the frame's context, the screen, and shows the toast and the file picker); every other
method is carried out by the server.

`anemo.call` returns a promise of the method's result. A failed call rejects with an
`Error` (its `name` is `AnemoError`) that has a `code`:

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
| `timeout` | no answer within 150 seconds (set by the SDK, not by Anemo's server) |

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
| `context.changed` | the new `context` | the panel now shows another object, the page's params changed, or another job is open on the Code page |
| `theme.changed` | the new `theme` | light/dark, accent or density changed (the variables are already updated) |
| `object.changed` | `{type, id}` | the object the panel shows was changed elsewhere: read it again |
| `layout.changed` | the new layout (as `layout.get`) | the window was resized, the page changed, the sidebar was folded, the message box appeared, went or grew (at most once per animation frame) |
| `composer.activity` | `{state}`: `focused`, `blurred`, `typing` or `idle` | the chat message box got or lost the focus, is being typed in, or the typing paused (never the text) |
| `assistant.activity` | `{state}`: `thinking`, `streaming` or `idle` | the assistant of the chat on screen started working, is writing its answer, or stopped (never the text) |
| `storage.changed` | `{key}` | another frame of this plugin wrote or deleted that storage key |
| `assets.changed` | `{key}` | another frame of this plugin wrote or deleted that asset |
| `command` | `{event}` | the user ran this plugin's `sendToUi` command for this UI (section 3) |
| `code.job` | `{device, project, jobId, state}` | `code.panel` only: a Claude Code job of the panel's project started or changed state. `state`: `running` (it started, or is running), `done`, `failed`, `cancelled` or `exited_without_result`. Sent once per change, never with the job's text |

`assistant.activity` and `composer.activity` are sent once right after start, with the
state then, and again on every change. `storage.changed` and `assets.changed` reach the
plugin's other frames open in the same browser tab (not the frame that wrote, and not
writes made by the plugin's scripts).

**Layout.** `layout.get` returns `{viewport: {width, height}, anchors, route}`. `route` is the
address path of the page shown (`/c/0193…`, `/tasks`). `anchors` has a rectangle
`{x, y, width, height}` for each known place that is on screen right now, and leaves out the
ones that aren't: `composer` (the chat message box) and `sidebar` (the menu, folded or not).
More may be added; ignore names you don't know. All numbers are CSS pixels in the
coordinates of **Anemo's window** (the top page's viewport), also for a frame that isn't
full-window: a panel has to subtract its own position, which it doesn't know, so these are
mostly useful to overlays.
## 6. Methods and object shapes

Params and results are JSON. Fields are **camelCase**, ids are strings, times are ISO 8601
(`2026-11-25T09:30:00+01:00`), dates `YYYY-MM-DD`. Optional params can be left out.

| Method | Params → result | Needs |
| --- | --- | --- |
| `context.get` | `{}` → the slot's `context` | – |
| `storage.get` | `{key}` → the value or `null` | – |
| `storage.set` | `{key, value}` → `{}` | – |
| `storage.delete` | `{key}` → `{}` | – |
| `storage.list` | `{prefix?}` → `{keys: [string]}` (sorted) | – |
| `assets.get` | `{key}` → `{dataUrl}` or `null` | – |
| `assets.set` | `{key, dataUrl}` → `{}`; `dataUrl` is `data:image/png\|webp\|gif\|jpeg;base64,…`, checked by its content, at most 10 MB | – |
| `assets.delete` | `{key}` → `{}` | – |
| `assets.list` | `{}` → `{assets: [{key, type, size}]}` (sorted by key; `size` in bytes) | – |
| `layout.get` | `{}` → `{viewport, anchors, route}` (section 5) | – |
| `tasks.list` | `{status?, projectId?, due?, query?, limit?}` → `{tasks: [Task]}`. `status`: a task status, `open` (the default: todo, in progress, waiting, blocked) or `all`; `due`: a date, due on or before it; `limit` 1–500 (default 100) | `tasks:read` |
| `tasks.get` | `{id}` → `Task` | `tasks:read` |
| `tasks.create` | `{title, description?, dueDate?, dueTime?, priority?, projectId?, tags?, checklist?}` → `Task`. `checklist` is a list of texts; a new task is `todo` | `tasks:write` |
| `tasks.update` | `{id, title?, description?, status?, dueDate?, dueTime?, priority?, projectId?, tags?, checklist?}` → `Task`; only the fields given change (`projectId: null` takes it out of its project); `checklist` replaces the list: `[{id?, text, done?}]` | `tasks:write` |
| `documents.list` | `{folder?, projectId?, limit?}` → `{documents: [DocumentSummary]}`; `limit` 1–500 (default 100) | `documents:read` |
| `documents.search` | `{query, limit?}` → `{documents: [DocumentSummary]}`; `limit` 1–20 (default 8) | `documents:read` |
| `documents.get` | `{id}` → `Document` (`id` may also be the document's path) | `documents:read` |
| `documents.create` | `{path, markdown}` → `DocumentSummary` | `documents:write` |
| `documents.update` | `{id, markdown}` → `DocumentSummary` (the whole text is replaced) | `documents:write` |
| `events.list` | `{from, to}`: dates (`YYYY-MM-DD`, `to` included, at most a year apart) → `{events: [Event]}`, repeating events expanded (one entry per occurrence, with `originalStart`) | `events:read` |
| `events.get` | `{id}` → `Event` | `events:read` |
| `events.create` | `{title, start, end?, allDay?, description?, location?}` → `Event` (`start`, `end`: ISO times) | `events:write` |
| `events.update` | `{id, title?, start?, end?, allDay?, description?, location?}` → `Event`; only the fields given change | `events:write` |
| `projects.list` | `{}` → `{projects: [{id, name, color}]}` (archived ones left out) | `projects:read` |
| `code.projects` | `{device, remote?}` → `{projects: [{name, path, remote, repo, cloned}]}`: the folders in that computer's projects folder (`cloned: true`; `remote`: its `origin` URL or `null`; `repo`: `owner/name` when that is on GitHub) and, unless `remote: false`, its owner's GitHub repositories that aren't cloned there (`cloned: false`, `path: null`; asking GitHub takes a few seconds) | `code:read` |
| `code.gitGraph` | `{device, project \| repo, limit?, all?, fetch?}` → `GitGraph` (below). `project`: a folder of `code.projects`; or `repo`: the `repo` (`owner/name`) of one with `cloned: false`, read from a cache on the computer (Anemo Desktop 1.6.0). `limit` 1–1000 commits (default 300); `all` (default `true`): the history of every local and remote-tracking branch, `false`: of HEAD only; `fetch` (default `false`): `git fetch --prune` first, so the remote branches are current (slower; 1.6.0) | `code:read` |
| `code.gitCommit` | `{device, project \| repo, hash}` → `GitCommit` (below); `hash` is 7 to 40 lower-case hex digits | `code:read` |
| `notifications.send` | `{title, body?}` → `{}` (title at most 120 characters) | `notifications:send` |
| `http.fetch` | `{url, method?, headers?, body?}` → `{status, headers, body}`; `method` one of `GET HEAD POST PUT PATCH DELETE OPTIONS` (default `GET`), `body` is text; the answer's body comes back as text, at most 1 MB | `network:<host of url>` |
| `tools.call` | `{name, args?}` → `{content, data, isError}` (`data` may be `null`) | `tools:<name>` |
| `scripts.run` | `{script, input?}` → `{runId}` (the result is in the run log later; not in a preview) | the script is this plugin's |
| `templates.apply` | `{template}` → `{type: "task"\|"document", id}` of what was created | `documents:write` or `tasks:write` |
| `ui.resize` | `{height}` → `{}` (40–2000; panels and blocks only, pages and settings fill their box) | – |
| `ui.toast` | `{message, tone?}` → `{}` (plain text, at most 200 characters; shown with the plugin's name) | – |
| `ui.open` | `{type: "task"\|"document"\|"event"\|"page", id}` → `{}` | the matching `:read`, or a page of this plugin |
| `ui.setHitRegions` | `{regions: [{x, y, width, height}]}` → `{}`; at most 8, each at most 320 × 320 CSS pixels of the window; `[]`: fully click-through. Overlays only | – |
| `ui.setVisible` | `{visible}` → `{}`: the overlay hides or shows itself. Overlays only | – |
| `ui.pickFile` | `{accept?, maxBytes?}` → `{name, type, size, dataUrl}`; `accept` is a list of `image/gif image/png image/webp image/jpeg` (default: all four), `maxBytes` at most 10 MB (the default). Opens the browser's file picker in Anemo's page; call it right after a click in the frame (otherwise `permission_denied`). `declined` when the user cancels | – |

Parameter names are camelCase, and an unknown parameter is an `invalid_params` error (so a
typo doesn't silently do nothing).

Storage: keys at most 100 characters, JSON values, 1 MB per plugin in total.

Assets: the plugin's own pictures (PNG, WebP, GIF, JPEG), e.g. one the user chose with
`ui.pickFile`. Keys at most 100 characters, at most 10 MB per asset and 25 MB per plugin in
total; each is checked by its content on the server. Like storage, they need no permission
and are deleted when the plugin is uninstalled.

### Task

```jsonc
{
  "id": "0193b0c2-…",
  "title": "Write the report",
  "description": "Markdown",
  "status": "todo",              // todo | in_progress | waiting | blocked | done | cancelled
  "priority": 0,                 // 0 none, 1 low, 2 medium, 3 high
  "dueDate": "2026-11-27",       // date or null
  "dueTime": "14:00",            // HH:MM or null
  "projectId": "0193…",          // or null
  "parentId": null,              // the parent task of a subtask
  "tags": ["work"],
  "checklist": [{ "id": "a1b2c3d4", "text": "Outline", "done": true }],
  "properties": { "mood": "good" },  // property key -> value
  "completedAt": null,           // ISO time or null
  "createdAt": "2026-11-20T08:00:00+00:00",
  "updatedAt": "2026-11-24T17:12:03+00:00",
  "url": "/tasks?task=0193b0c2-…"    // its address in Anemo (ui.open takes the id)
}
```

### DocumentSummary and Document

```jsonc
// DocumentSummary
{
  "id": "0193…",
  "path": "documents/notes/idea.md",   // where it is in the workspace
  "title": "Idea",
  "wordCount": 412,
  "properties": {},
  "createdAt": "2026-11-20T08:00:00+00:00",
  "updatedAt": "2026-11-24T17:12:03+00:00",
  "url": "/documents/0193…"
}
// Document = DocumentSummary plus
{
  "markdown": "# Idea\n\nThe whole text, front matter included."
}
```

### Event

```jsonc
{
  "id": "0193…",                 // an occurrence of a repeating event has the event's id
  "title": "Dentist",
  "description": "",
  "location": "",
  "start": "2026-11-27T09:30:00+01:00",
  "end": "2026-11-27T10:15:00+01:00",
  "allDay": false,               // all-day: start is midnight of the first day, end midnight after the last (in timeZone)
  "timeZone": "Europe/Kyiv",
  "recurring": false,            // true when the event repeats
  "projectId": null,
  "taskId": null,                // the task it was planned for, if any
  "properties": {},
  "url": "/calendar?event=0193…",
  "originalStart": "2026-11-27T09:30:00+01:00"   // events.list only: when this occurrence was due by the rule
}
```

### GitGraph and GitCommit

`code.gitGraph` and `code.gitCommit` read a repository on a computer through Anemo Desktop
(section 4, Code panels). The device is the computer's name; the repository either a
project's folder name (`project`) or, for one of the owner's GitHub repositories that isn't
cloned there, its `repo` (`owner/name`, from `code.projects`; never a URL). Give exactly one.
Hashes are full 40 hex digits (64 in a SHA-256 repository).

```jsonc
// GitGraph
{
  "head": { "branch": "main",        // null when detached; in an empty repository, the branch to be
            "commit": "3f2a…",       // null in a repository without commits
            "detached": false },
  "branches": [{ "name": "main",            // a remote-tracking one: "origin/main"
                 "commit": "3f2a…",
                 "remote": false,
                 "upstream": "origin/main",  // or null
                 "ahead": 2, "behind": 0,    // commits ahead of and behind its upstream
                 "current": true,            // HEAD is on it
                 "pullRequest": { "number": 90, "title": "Add the graph", "headRef": "main",
                                  "url": "https://github.com/artem/anemo/pull/90",
                                  "draft": false } }],  // the open one from this branch, or null
  "tags": [{ "name": "v1.0", "commit": "9b1c…" }],   // an annotated tag: the commit it points at
  "commits": [{ "hash": "3f2a…",
                "parents": ["9b1c…", "77de…"],       // two or more for a merge; [] for a first commit
                "authorName": "Artem",
                "authorEmail": "artem@example.com",
                "date": "2026-11-25T09:30:00+01:00", // the author's date
                "subject": "Merge branch 'feature'",
                "refs": ["HEAD", "main", "origin/main", "tag: v1.0"] }],
  "status": { "dirty": true,         // any of the four below
              "staged": 1, "unstaged": 2, "untracked": 3, "conflicted": 0 },  // null for a repo
  "remotes": [{ "name": "origin", "url": "https://github.com/artem/anemo.git" }],  // credentials removed
  "truncated": false,                // there are more commits than limit
  "source": "local",                 // "remote": a repo that isn't cloned, read from the cache
  "repo": "artem/anemo",             // owner/name on GitHub, or null
  "fetchedAt": "2026-11-25T09:00:00Z",  // the last fetch, or null (never, or Anemo Desktop 1.5.0)
  "fetchError": null,                // fetch was asked for and failed: why (the rest is still read)
  "pullRequests": [ /* the open ones, as in pullRequest above */ ]  // null: gh isn't signed in there
}
// GitCommit
{
  "hash": "3f2a…", "parents": ["9b1c…"], "authorName": "Artem", "authorEmail": "artem@example.com",
  "date": "2026-11-25T09:30:00+01:00",
  "committerDate": "2026-11-25T09:31:00+01:00",
  "committerName": "GitHub",         // "" from Anemo Desktop before 1.6.0
  "subject": "Fix the login",
  "body": "The rest of the message.",
  "files": [{ "path": "src/login.ts",
              "status": "M",         // git's letter: A M D R C T
              "additions": 12, "deletions": 3 }],   // null for a binary file, and for a repo
  "stats": { "files": 1, "additions": 12, "deletions": 3 },
  "truncated": false                 // more than 1000 files: the list is cut, stats are not
}
```

Commits come newest first in topological order (`git log --topo-order`: a commit before its
parents), so a graph can be laid out from the list as it is. A merge is compared with its
first parent. Nothing else is read: no file contents, no diffs.

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
| `code:read` | list the projects on your computers and read their git history (`code.*`): branches, commits, changed file names, whether there are uncommitted changes. A fixed set of read-only git commands run by Anemo Desktop; never file contents or diffs | high |
| `notifications:send` | send the user a notification | high |
| `network:<host>` | `http.fetch` to that host (`network:*.example.com` = its subdomains) | high |
| `tools:<tool name>` | call that agent tool (built-in, or `mcp__<server>__<tool>`) | high, or critical |

**Critical** are tools that control a device, a shell or a computer (`shell.*`,
`computer.*`, `browser.*`, `code.run`, `agent.spawn`, `focus.control`, `voice.control`): they
can be granted, but every single call asks the user. Settings and secrets can't be reached by
plugins at all.

Ask for as little as possible: the review shows each permission with its risk, and read
permissions carry the warning that what a plugin can read, it could send out. UI slots
need no permission (they are shown as low risk, an `overlay` as medium: it draws over
Anemo's window). The plugin's own storage and assets, the layout and the activity events
need none either.

What scripts may call is limited by the same permissions: a script's `tools` must be
covered (`tasks:read` covers `list_tasks`, `get_task`, `list_projects`; `tasks:write`
covers `create_task`, `update_task`, `delete_task`; `documents:read` covers
`list_documents`, `read_document`, `search_documents`, `list_properties`;
`documents:write` covers `write_document`, `edit_document`, `set_document_properties`;
`events:read` covers `list_events`, `get_event`; `events:write` covers `create_event`,
`update_event`, `delete_event`; `code:read` covers `code_projects`, `code_git_graph`;
`notifications:send` covers `send_notification`;
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
  different height with `ui.resize`. The exception is the `overlay` slot (section 4): a
  window-sized layer that lets clicks through outside its hit regions and stays below, and
  hidden behind, every dialog of Anemo's.
- **No files of the user's** except a picture the user chooses with `ui.pickFile`.
- **Images and fonts** must be in the package or made in the page (`data:`/`blob:` URLs).
  Package pictures reach the frame as `data:` URLs (section 5). `.svg` files aren't
  allowed; inline `<svg>` elements in the HTML are fine.
- No `eval` of remote code is possible anyway; don't `eval` data either.

## 9. Theme and base styles

`theme` is `{mode: "light"|"dark", density, vars, reducedMotion}`. The `vars` are already
set on the frame's `:root`, so CSS can use them directly; they change with `theme.changed`.
`reducedMotion` is `true` when the user asked their system for less motion
(`prefers-reduced-motion`): keep animations still or short then. It is updated through
`theme.changed` too.

| Variable | Use |
| --- | --- |
| `--bg`, `--surface`, `--surface-2`, `--surface-hover`, `--card` | backgrounds, from the page to raised cards, and hover |
| `--text`, `--muted`, `--subtle` | text, secondary text, hints |
| `--border`, `--border-strong` | lines and outlines |
| `--accent`, `--accent-hover`, `--accent-soft`, `--accent-contrast` | the user's accent colour, its hover and soft forms, and text on it |
| `--success`, `--warning`, `--error`, `--info` | states |
| `--radius-card`, `--radius-control` | corner radii |
| `--font-ui`, `--font-code` | the user's fonts |
| `--shadow-soft` | a soft shadow for raised things |
| `--card-x`, `--card-y`, `--row-y`, `--card-gap`, `--stack-gap`, `--item-x`, `--item-y` | spacing at the current density |
| `--btn-h`, `--btn-sm-h` | the height of buttons and of small buttons |

The mode is also on `:root` as `data-theme="light|dark"`, the density as
`data-density="comfortable|compact"`.

A small base stylesheet is added before the plugin's own CSS: the body uses the UI font,
text colour and a transparent background; headings, links, `code`/`pre`, tables, `button`,
`input`, `select`, `textarea` and `label` look like Anemo's. Classes:

| Class | What |
| --- | --- |
| `.card` | a card |
| `.muted`, `.subtle` | secondary text, hints |
| `.small`, `.num` | smaller text; tabular numbers |
| `.stack` | a column with gaps |
| `.row` | a line of items with gaps |
| `.list` | a `<ul>` of rows with lines between them |
| `.badge`, `.badge.accent` | a small label |
| `button.primary`, `button.ghost`, `button.danger`, `button.small` | button kinds (a plain `button` is secondary) |

Style on top of it with your own CSS, using the variables instead of fixed colours so light
and dark both work.

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
| Invalid `id` | Lowercase, at least two dot-separated parts: `yourname.plugin-name`. Don't use `anemo.` (only plugins shipped with Anemo may). |
| Invalid `version` / not higher | Use `MAJOR.MINOR.PATCH`; after an approval every change needs a higher version than every stored one. |
| Unknown permission | Use one of section 7; `network:` needs a host (`network:api.example.com`), `tools:` a tool name. |
| A referenced file doesn't exist | `entry`, `icon`, `readme`, template and script `file`s must be paths inside the package, exactly as written (case matters). |
| File type not allowed | Only `.json .md .txt .html .css .js .mjs .ts .png .webp .gif .jpg .jpeg .woff2`. Convert an `.svg` icon to PNG or inline it in the HTML. |
| Path not allowed | Relative, `/`, no `..`, no leading `/`, no hidden names (`.env`, `.gitignore`). |
| File too large / too many files | At most 1 MB per file, 5 MB and 500 files in total. Remove bundled libraries you don't need. |
| A picture doesn't match its type | The bytes of `icon.png` must be a real PNG, of `x.gif` a GIF, of `x.jpg` a JPEG (send binary files as base64, see section 12). The icon itself is PNG or WebP. |
| `slot` unknown / `objects` missing | Slots: `object.panel` (needs `objects`), `page`, `settings` (at most one), `chat.block` (needs `fence`), `overlay` (at most one), `code.panel` (needs a `title`). |
| `unavailable` from `code.gitGraph` | The computer is offline, watched (not trusted), doesn't share its Claude Code jobs, isn't signed in to GitHub (for a `repo`), or has an Anemo Desktop older than 1.5.0 (1.6.0 for a `repo`): the message says which. `not_found`: no computer, project, repository or commit of that name. |
| A command names an unknown UI | `sendToUi`'s `ui` must be the `id` of one of this plugin's `contributes.ui`. |
| `invalid_params` from `ui.setHitRegions` | At most 8 regions of `{x, y, width, height}` (no other fields), each larger than 0 and at most 320 × 320; only an overlay has them. |
| `permission_denied` from `ui.pickFile` | Call it straight from a click (or key) handler in the frame, not from a timer or after a slow call. |
| `invalid_params` from `assets.set` | `dataUrl` must be a base64 `data:` URL of a PNG, WebP, GIF or JPEG whose content matches its type, at most 10 MB; the plugin's assets are at most 25 MB together. |
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

Files are given as `{"path": "text"}`. Binary files (`.png`, `.webp`, `.gif`, `.jpg`, `.jpeg`, `.woff2`) are given
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

On a plugin's page the user can also press **Continue building with the assistant**: it
opens a new Agent-mode chat linked to the plugin (`POST /api/plugins/{id}/chat`, with an
optional `{message}` saying what they want changed) whose first message asks you to read
the plugin. That chat counts as one of the plugin's own chats.
