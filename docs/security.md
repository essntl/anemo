# Security and permissions

The idea behind Anemo: **what an agent may do is decided by the server, from your
settings, for every single action.** Nothing a model writes can grant a permission,
approve a request or change a setting. This page says what is enforced, where, and
what is not.

## Who can get in

- One user. The name and password come from `.env`; there is no sign-up.
- Sessions last 30 days and are listed (and can be ended) in **Settings → General**.
- Five wrong passwords lock logins for a minute. The counter clears on its own;
  restarting the app does not clear it.
- Sections marked with a shield (providers, agent permissions, workspace, web,
  MCP) ask for your password again if you logged in more than 15 minutes ago.
- Logins, setting changes, approvals and denials are in the security log under
  **Settings → Advanced**.

## API tokens (the browser extension)

**Settings → General → Extension and device tokens** makes long-lived logins for Anemo
Companion (the browser extension, `extension/`) or another device. A token is sent as
`Authorization: Bearer …`.

- **Shown once.** Only its SHA-256 is stored; the list shows its name, its first
  characters, when it was made and when and from where it was last used.
- **Revocable.** Revoking deletes it and it stops working at once; the extension then goes
  back to its setup screen. Making one needs your password again (it is a login that lasts
  until revoked); making and revoking one are in the security log.
- **Less than a login.** A token never counts as "password entered recently", so it can't
  change providers, agent permissions, the workspace or web settings, MCP servers or
  notification destinations, and it can't make tokens. It can't log out, confirm the
  password or manage browser sessions either.
- **The Origin check.** Changes from another site are refused (see the cross-site check in
  `backend/app/api/security.py`). The only exception: requests from Anemo Companion's
  extension id (`EXTENSION_IDS`, default its fixed id) that carry a token. The browser login's
  cookie is still refused from there. No CORS headers are sent: an extension with permission
  for your Anemo address doesn't need them, and web pages get none.
- **The extension's live connection** (`/api/extension/ws`, a WebSocket) accepts only
  Anemo Companion's origin, and its token in the first message (never in the address, so
  not in proxy logs). The token is checked again every minute: revoking it closes the
  connection.
- **"Skip Discord while I'm here".** When this option is on in the extension, it reports
  whether the computer is in use (Chrome's idle detection, 5 minutes). While it is,
  notifications are shown in the browser and not copied to Discord; the skipped copy is
  recorded as `skipped`. A closed browser or lost connection counts as away after 90
  seconds. Destinations an automation names itself, and test messages, are always sent.
- **Saving web content** (quick capture): the extension sends what it read; the
  "Inline & formatting" model (Settings → Models) reformats it before it is written into a
  document. That model sees only the content, fenced and labelled as untrusted, and at most
  the target document's headings; never the document's text, your memories, other chats or
  tools. A page could still try to make the formatter write something misleading into the
  document; review saved clips like any text from the web.
- **Pages attached to a chat message** are kept apart from the message, wrapped and
  labelled as untrusted data for the model, and never used for memories (nor are the answers
  to such messages).

## Devices (Anemo Desktop, Anemo Voice)

A computer or phone added in **Settings → Devices** gets a token of its own, made and
shown like the tokens above: once, only its hash stored, adding a device needs your
password again.

- **What a device token can do.** What an extension token can (see above), so nothing
  that needs the password again: it can't change trust levels, permissions, providers or
  other devices, can't add devices or tokens, and can't rename a device (the agent finds
  devices by name). Deleting the device in Settings → Devices deletes the token: its
  requests get 401 and its connection closes at once. Revoking its token from the general
  token list instead closes the connection within a minute (at the next check).
- **Rolling back by hand.** If the database is taken back past the devices migration
  (`0072`, with `alembic downgrade`), the devices' tokens stay behind as ordinary, valid
  API tokens. Delete the devices (or revoke their tokens) first. Restoring a backup made
  before the update avoids this.
- **The connection** (`/api/devices/ws`) carries the token in its first message, never in
  the address. A connection that sends an `Origin` header is refused, so a web page can't
  pose as a device (devices are native programs; the extension, which must send its
  origin, has its own connection). The token is checked again every minute; a newer
  connection of the same device replaces the older one. Commands reach a computer only
  over this connection; a phone gets only the events of the runs it started itself.
- **Trust levels.** A *watched* computer (the default) is asked about before every
  click, keystroke, key press and program it opens, every time: *Allow for this run* and
  "Fully autonomous" don't change that. The PowerShell tool is not offered there at all.
  A *trusted* computer follows **Agent Permissions** (*See your computers*, *Use your
  computers*, *Commands on your computers*), so it can be made fully autonomous. Use it
  for the agent's own VM, not for a computer with your logins on it. Changing the level
  needs your password, is in the security log, and makes the client reconnect so it
  reads the new level. The server checks the level, the client's *Allow control* and its
  PowerShell switch again just before each command, and the client checks them too.
- **Looking is not asked about, on a watched computer too.** *See your computers*
  defaults to *Ask for dangerous actions*, and a screenshot or reading the window in
  front is a safe action, so by default the agent looks at any connected computer
  without asking. *Allow control* off and the pause stop acting, not looking. Those
  screenshots are kept in the run's timeline, so they are in Anemo's data and its
  backups. To prevent it, set *See your computers* to *Always ask* (or *Never*), or quit
  Anemo Desktop on that computer.
- **The PowerShell switch is not a boundary for acting.** Switching PowerShell off in the
  client only takes away the PowerShell tool. While control is allowed, the agent can
  still open a terminal from the Start menu or with Win+R and type into it, as an
  ordinary action: asked every time on a watched computer, decided by *Use your
  computers* on a trusted one. The hard boundaries are a watched computer, *Allow
  control* off, and the pause (Stop).
- **What the agent can do on a computer** is what the logged-in Windows user can do in
  the programs on its screen (a terminal included), and on a trusted computer with
  PowerShell on, also through the PowerShell tool. The client runs without admin rights,
  can't act on the secure desktop (UAC prompts, the lock screen), never types into
  password fields, never sends Ctrl+Alt+Del, and can't use its own windows. **Stop**
  (Ctrl+Alt+Shift+S) on the computer cancels the running command and takes control away
  for an hour; the server sends no action until the client offers control again
  (looking still works, see above).
- **Screens are untrusted.** Screenshots, window text and a shared screen can contain
  text written to steer the agent (an email, a web page, a document). They reach the
  model labelled as untrusted, like web pages, and what contains the damage is the
  check on every action, not the model's judgement. A shared screen is a copy sent once
  when you ask; it is kept in Valkey for 12 hours at most, and the API never returns its
  content.
- **Voice.** A spoken reply goes through the same approval check as the app's buttons
  and is in the security log marked as coming from voice. An action rated dangerous is
  never decided by voice, and with *Allow approvals by voice* off only questions are. A
  spoken yes or no is recognised in English, Ukrainian and Russian; in other languages it
  comes back as unclear and the notification decides.
  Anyone near the phone while it asks "Allow?" can answer it, as they could tap the
  notification on an unlocked phone; turn approvals by voice off if that matters to
  you. The recording and the transcript of a request or reply are not stored.

## Share links

Anemo has one user, but you can let someone **read** a single chat, document or
project by giving them a link (**Share** in the menu of a chat, a document or
a project). This is the only thing reachable without logging in, apart from the login
page itself and the one-time [buttons on push notifications](#push-notifications).

- **A link shows a frozen copy.** The copy is made when you create the link and is
  stored with it. Opening a link reads that copy and nothing else: no live chat, no
  file, no setting. It changes only when you press **Update copy**.
- **What a copy contains.** A chat: the messages, the model's name, and the *names* of
  attached files and referenced chats. A document: its text. A project: the
  sections you tick, which are its tasks (with their notes), its upcoming events and
  its documents (the text of each, to read in full). Never included: attached files
  and workspace images, the model's reasoning, what an agent did, and a project's
  chats, files and instructions. Links from a task or document to another one are
  rewritten for the copy: to its place in the same copy when it is part of it,
  otherwise to plain text, so no internal address or id reaches a visitor.
- **A visitor can only read.** There is nothing to write to, no model is called and no
  agent or tool can be reached through a link.
- **The address is the secret.** It contains 256 random bits; anyone who has it can read
  the copy, so share it the way you would share the text itself. The page is marked as
  not to be indexed and does not pass its address on to sites it links to.
- **Links end.** They expire after 1, 7 or 30 days (7 by default) unless you choose
  "until I revoke it". **Revoke** stops a link at once, deleting the chat, document or
  project deletes its links, and **Settings → Shared links** lists every link with how
  often it was opened, and can revoke them all. Missing, expired and revoked links
  look the same to a visitor. Wrong addresses are limited to 30 a minute per IP.
- Creating and revoking links is in the security log.

A link only works for people who can reach your server. If Anemo is only on your home
network, so are its links.

## Push notifications

Push notifications (Settings → Notifications → Push) reach a browser or phone through
its push service (Google's for Chrome, Mozilla's for Firefox, Apple's, Microsoft's).

- **The push service can't read them.** Every notification is encrypted for that one
  browser (RFC 8291) and signed with this server's own key (VAPID, RFC 8292). The
  server's key is made on first use and stored encrypted with `APP_SECRET_KEY`, like
  the browsers' subscriptions (address and keys), which the API never returns.
- **Short.** A push carries the title, a line or two of text (at most 200
  characters) and the page to open; never a whole message, file contents or a secret.
- **Only real push services.** A subscription address must be `https://` on the
  standard port and not a private or local host, and every connection is checked again
  when it is made, like the addresses agents visit (so DNS tricks can't send it into
  your network). Redirects are not followed. Turning push on asks for your password
  like the other notification settings, and a device the push service reports as gone
  is removed by itself.
- **The approval buttons.** When an automation waits for a plain yes or no, its push
  notification has *Allow once* and *Deny*. Each button carries a random 256-bit token,
  sent only inside the encrypted notification; the server keeps only its SHA-256. The
  button needs no login (the phone may have none open), and this is what it can do:
  - answer that one approval, only *once* (never "for this run"), and only while it is
    still waiting, at most for the approval's own 24 hours;
  - work one time: using any button removes every button for that approval, on every
    device. A used, expired or unknown token gets the same answer, and wrong tokens are
    limited to 30 a minute per IP;
  - nothing else: no data is returned, and plans, questions and several waiting
    requests at once get no buttons (the notification opens the app).
  Answers given this way are in the security log, marked as coming from a push
  notification. Anyone who can see your unlocked phone's notifications can press the
  buttons, as they could open the app there.

## Update check

About once a day the worker asks GitHub's API how many commits `main` has that the
running build doesn't. It is the only outside request Anemo makes on its own: a plain
HTTPS GET to `api.github.com` with a fixed User-Agent (`Anemo-update-check`), no
cookies, no token and nothing about you or your data; the answer only fills Settings
→ Advanced. Anemo never downloads or installs anything itself. Switch it off in
Settings → Advanced or for good with `UPDATE_CHECK=false`.

## Appearance uploads

Backgrounds, fonts and the avatar (Settings → Appearance and Profile) are recognised by
their content, never by the file name or the type the browser sends
(`features/appearance/files.py`): pictures must open in Pillow as PNG, JPEG, WebP, AVIF or
GIF, videos must have a WebM or MP4 header, fonts the magic bytes of WOFF2, WOFF, TTF or
OTF. SVG, and anything else that starts like XML or HTML, is refused, because an SVG can
carry script. Each kind has a size cap, and at most 60 uploads are kept. Still pictures
are re-encoded (no EXIF, GPS or XMP is kept); animated pictures and videos are stored as
sent.

They are served with the type we recognised, `X-Content-Type-Options: nosniff`,
`Content-Security-Policy: default-src 'none'` and a file name of our own. Every route needs
a login. Colours and fonts reach the page only as CSS variables built from checked values
(hex colours, a fixed list of font names, ids of uploads), never as CSS from the user.

## Images in answers and documents

Answers, documents, task notes and notifications can contain Markdown written by a model or an
agent, which may have read a page with instructions planted in it. An image address can carry
data (`https://example.org/x.png?q=…`), and the browser sends it as soon as the image loads. So
only images from Anemo itself (and `data:`/`blob:` images) load by themselves; an image from
another site shows as a "show image from example.org" button and loads when you click it. The
document itself is not changed.

Pictures made with `generate_image` are shown from Anemo too. When an image provider
answers with an address instead of the picture, the server fetches it with the same guarded
client as web pages (no addresses on your network unless allowed), at most 25 MB, and keeps
it only if the server says it is an image and the bytes are a PNG, JPEG, WebP or GIF. The
provider's API key stays an encrypted secret: the model never sees it. Each picture costs
money, so automation runs ask before each call unless you switch that off in Settings →
Providers & Models → Image generation; that rule can only make a call stricter.

## Diagrams, charts and math

Diagrams can be written from untrusted content (a web page an agent read, a shared
document), so drawing one can't do more than show a picture:

- Mermaid runs in its **strict** mode with plain-text labels (no HTML) and no click
  handlers. A diagram's own `%%{init}%%` settings can't change that, the theme or the
  CSS.
- The drawing is cleaned again before it goes into the page: only SVG is kept (no
  scripts, event handlers, embedded HTML or images), links keep only targets inside
  the drawing (`#…`), and CSS loses `url(…)` and `@import`. So nothing is loaded from
  another site and nothing runs.
- Charts are drawn by the app itself from validated numbers and labels (rendered as
  text).
- Formulas use KaTeX with `trust` off, so commands such as `\href`, `\url` or
  `\includegraphics` don't work. KaTeX, its fonts and Mermaid are part of the app;
  nothing comes from a CDN.

## Plugins

A plugin (Settings → Plugins, spec `docs/specs/12-plugins.md`) is code and settings
someone else wrote, so it gets nothing by default:

- **Nothing runs unreviewed, nothing widens silently.** A new plugin waits until you
  approve it with your password; the approval names the hash of the exact files you
  reviewed (a newer upload in between is refused) and grants its permissions to the
  plugin. An update you install yourself applies at once only when it asks for nothing
  beyond those grants and adds or changes no MCP server; anything wider waits, and the
  running version stays until you approve. Every change an assistant saves waits for
  review: its tools can create and change plugins, never approve, enable or grant. (So
  an update you upload can change a plugin's code without a second look: install
  updates only from where you got the plugin.)
- **Its UI is sealed off.** Each panel or page runs in an `<iframe sandbox="allow-scripts">`
  with an opaque origin, loaded from one fixed document whose Content-Security-Policy
  blocks every request (`default-src 'none'`, `connect-src 'none'`, pictures and fonts
  only `data:`/`blob:`). It has no access to your cookies, the app's storage or the page,
  and it receives its own files from the app over a private message channel. It asks the
  app for data through named methods; the page checks each against the approved
  permissions, then the server checks it again.
- **Every call is a tool call.** On the server a plugin call goes through the same
  permission engine as an agent's tool call, with only what the approved permissions
  cover allowed. Shell, computer, browser and device tools are *critical*: a plugin may
  hold them, but every single call asks you in Anemo's own dialog (never in the plugin's
  frame), with no "for this run" or "always". What a plugin writes carries
  `plugin:<id>@<version>`, and its writes, confirmations and refusals are in the security
  log.
- **Your computers' code is read, never run.** `code:read` (high risk) lets a plugin list
  a trusted computer's projects and read their git history through Anemo Desktop: a fixed
  set of read-only git commands with argument lists (no shell), in a folder inside the
  projects folder (no `..`, no links out), with hooks such as `core.fsmonitor` turned off.
  The server checks the project name, the commit hash and the limit before asking, and the
  answer's shape after; only metadata comes back (no file contents, no diffs, no
  credentials from remote URLs).
  Anemo's own Git view on the Code page uses the same reads. A GitHub repository that
  isn't cloned is named only as `owner/name`, and Anemo Desktop takes it only if it is in
  its owner's `gh repo list` (it clones the URL from that list, never one it is sent) into
  a size-capped blobless bare cache in its own data folder (outside the projects folder,
  with the same link check). A fetch (`git fetch --prune`, only when asked: the Refresh
  button or `fetch: true`) runs with hooks off and the `ext`/`file` transports refused; it
  uses the computer's own git credentials, which never leave it. Pull requests come from
  `gh pr list` with fixed arguments, and only github.com links are passed on.
- **Its output is data.** Results of plugin scripts and plugin MCP tools reach models
  marked as untrusted, and when an agent reads a task, document or event a plugin wrote
  last, the text is labelled with the plugin and marked as untrusted. (Static text you
  reviewed as part of a version, such as a skill's instructions, is used as written.)
- **Logic runs in existing sandboxes**: plugin scripts in the Deno sandbox (see
  *Scripts* above), plugin MCP servers in the MCP host or remotely; their tools ask every
  time until you change that. Never in the app's own processes.
- **Packages** are checked before anything is stored: at most 500 files and 5 MB, safe
  paths only (no `..`, no links), a fixed list of file types (no SVG, no executables),
  pictures and fonts recognised by their content. Every file's SHA-256 is recorded and
  checked again when it is used. A Git address must be https and public; it is cloned
  without credentials, after the host is checked like any web address.
- **Kill switch.** *Turn off all plugins* stops every frame, call, command, script and
  plugin MCP tool at once.

## Permission levels

**Settings → Agent Permissions** has one level per kind of action:

| Level | Meaning |
|---|---|
| Never | The agent cannot do it and is told so. |
| Always ask | The run pauses and waits for you every time. |
| Ask for dangerous actions | Routine actions go ahead; risky ones wait for you. |
| Allowed in workspace | Goes ahead inside your workspace; anything else waits for you. |
| Fully autonomous | Goes ahead without asking, still inside the fixed limits below. |

The kinds of action and their defaults:

| Action | Default |
|---|---|
| Read files | Allowed in workspace |
| Create and edit files, delete files | Always ask |
| Run shell commands, shell with network | Always ask |
| Web search | Fully autonomous |
| Read web pages | Ask for dangerous actions |
| Browser, external API calls | Always ask |
| Edit documents | Always ask |
| Manage tasks, manage calendar, send notifications | Ask for dangerous actions |
| Update memory | Fully autonomous |
| MCP tools | Always ask (each tool can be set on its own) |
| Start sub-agents | Never |
| Generate images | Fully autonomous (automations ask first, see below) |
| See your computers | Ask for dangerous actions (looking is safe, so it goes ahead) |
| Use your computers | Always ask (a watched computer asks every time whatever the level) |
| Commands on your computers | Always ask (never offered on a watched computer) |

Whether an action is "dangerous" is decided by code, not by the model: for
example `rm -r`, `git push --force`, piping a download into a shell, or any
command that cannot be parsed. These checks can only make an action stricter.

### Layers

Several rule sets can apply to one action, and **the strictest one wins**:

1. **Fixed rules** in code: paths outside the workspace, settings and secrets are
   never available to agents, whatever the settings say.
2. **Your ceiling**: the most any agent may ever do.
3. **The profile or automation** the run uses.
4. **The parent run**, for sub-agents: a sub-agent can never do more than the
   agent that started it.

The rules are copied onto a run when it starts. Changing settings affects new runs.

### Approvals

When a run waits for you, you can approve once, approve for the rest of that run
(for that kind of action in that place), or deny, with a reason the agent sees.
An approval for the run never overrides "Never" or the ceiling, and some actions are
asked about every time regardless: clicks, hovering, typing and key presses in your own
Chrome, and creating a schedule or changing what one does or when (the request shows the
prompt and the times). Unanswered
requests expire after 24 hours and count as denied. Unattended automations follow
their own setting for this: wait and notify you, skip the action, or stop.

### Limits

Every run has limits on steps, tool calls, running time, cost, repeated errors and
sub-agent depth. When one is reached the run stops and says which.

## What isolates agents

| Part | Boundary |
|---|---|
| File tools | Paths are resolved and must stay inside the workspace; links that point outside are refused. Deletes go to the trash; changed files can be put back from the run. |
| Shell | Runs in a separate container as a non-root user, with a read-only system, no extra privileges and memory/CPU/process limits. The default sandbox has **no network at all**. A second one with internet access is a separate permission. Neither can reach the database. |
| Web pages and API calls | Addresses on your own network, the Docker host and cloud metadata addresses are refused unless you list them in Settings → Web & Search. Redirects are checked again. |
| Browser | Its own container without workspace, database or secrets; the same address rules apply to everything it loads. |
| Your own Chrome (browser control) | Only while you switch it on in Anemo Companion, never for automations, and only in tabs the agent opened in an "Anemo" tab group. Opening, reading and following links are allowed by default ("Your own Chrome" permission); every other click and all typing are asked about every time, whatever the level says ("allow for this run" doesn't apply). The extension never types into password fields and never uses Anemo itself, browser pages, `.gov` sites, banks or its blocklist. Commands reach it only over its authenticated WebSocket. It acts with that browser's logins, so use a separate Chrome profile. |
| A tab you shared | "Share this tab with Anemo" in Anemo Companion sends a copy of that one page's text. The agent can read that copy (no approval; "Never" for "Your own Chrome" takes the tool away), and nothing else: it cannot list or read other tabs, or see the shared one again after it changed. One tab at a time, forgotten after 12 hours or when you stop sharing; kept in Valkey, not the database. Not for automations. |
| Music through the server | With "Keep playing in the background" on (Settings → Music), a YouTube track's audio is fetched by the Anemo host and passed on to your browser; nothing is stored. yt-dlp is given only an address built from an 11-character video id, with only its YouTube extractor enabled; the stream itself is fetched through the guarded client and only from YouTube's media hosts (`*.googlevideo.com`, https), so the route cannot be pointed at your network. It needs a signed-in session like every other route. YouTube's terms do not provide for this way of playing; switch it off to use YouTube's own embedded player only. |
| Video transcripts | Read with yt-dlp on the Anemo host, from YouTube, Vimeo, Dailymotion and TED addresses only (checked by host name; yt-dlp's fetch-anything extractor is off), so the tool cannot be pointed at your network. If YouTube blocks the server and browser control is on, the transcript is read through your Chrome instead (a read, like opening a page there). |
| Scripts | A script's code runs in Deno as a child process of the worker with no permissions except its own folder (`/data/scripts/<id>`): no network, no environment variables, no subprocesses, no other files, no remote or npm imports; 256 MB of memory, the automation's time and tool-call limits, 1 MB per message, 64 KB of log and of result. It reaches Anemo only through JSON messages the worker answers: each call is checked against the version's tool list (and web addresses against its hosts) and then goes through the permission engine and approvals exactly like an agent's, as the automation's run. Code an agent writes or changes is saved switched off and never runs until you approve that exact version (by its hash, with your password); `update_schedule` cannot switch a script on. `think` gives its data to a model inside an untrusted block, with no tools unless the script lists some. Secrets are filled in by the worker only in request headers to a declared host and replaced by their placeholder in what comes back. Deno has no kernel-level isolation: approved code runs inside the worker container. |
| Schedules | An agent can set up a prompt that runs by itself (an automation) only with your confirmation, every time, whatever the "Schedules" level says. Scheduled runs wait for you when an action needs approval, cannot create or change schedules themselves, are stopped after the time limit for scheduled runs (30 minutes unless changed), run at most every 5 minutes, and all stop starting while "Pause all" is on (Automations page). |
| Deleting | Files, tasks and calendar events an agent deletes go to a trash only you can restore from or empty. Forgetting a memory and deleting a schedule are permanent; both say so. |
| MCP | Local MCP servers run in their own container without database, workspace or app secrets. Each tool is permission-checked. If a server changes a tool's definition, the tool is switched to "ask" until you review it. |
| Claude Code | Runs in its own container without workspace, database or app secrets, and with no tools of its own: every tool call it makes is a normal Anemo tool call, checked here. |
| Your computers (Anemo Desktop) | No isolation from the computer itself: the client acts as the logged-in Windows user, so the trust level and the permissions are the boundary (see [Devices](#devices-anemo-desktop-anemo-voice)). A watched computer asks before every action and never gets the PowerShell tool. Not for automations unless the automation lists the tool. |

## Claude subscription (Claude Code)

The optional `claude-runner` container lets Anemo use your Claude subscription by
driving the Claude Code CLI ([details](claude-code.md)). Claude Code acts only as the
model: it has no built-in tool, no MCP server except Anemo's own bridge, no settings,
skills, plugins or claude.ai connectors, and every tool call it makes comes back to the
worker and goes through the permission engine like any other model's. Only the worker
can reach the runner (internal network plus a token). The Claude Code login stays in the
`claude-config` volume, mounted in that container only: Anemo never reads, stores, logs
or forwards it, and the CLI's environment is built from an allowlist (no Anthropic API
key, token or base URL, none of Anemo's secrets).

## Secrets

API keys, webhook addresses, push subscriptions and keys, MCP credentials and the
values of script secrets are encrypted in the database with
`APP_SECRET_KEY`. The API never returns them (you see the last four characters),
they are not written to logs or run records, and they are never given to a model
or a tool. The test suite checks this by saving a key, running an agent and then
searching every response, record and stored file for it.

## What this does not protect against

- **The shell sees the whole workspace.** Per-folder access applies exactly to the
  file tools; a shell command can read any file in the mounted workspace. Do not
  keep things in the workspace that an agent with shell access must never see.
- **Text from the web can try to steer a model.** Pages, files and tool results are
  marked as untrusted, but a model can still be misled. What contains the damage
  is the permission check on every action, not the model's judgement. "Fully
  autonomous" shell with network plus web access is the riskiest combination;
  prefer "ask" there.
- **What you approve, runs.** Read approval requests; the exact command or change
  is shown.
- **An approved script runs as written, unattended.** Read the code (and the diff of a
  change) before approving it. Its sandbox is Deno's permission system, not a separate
  container: a flaw in Deno or V8 would reach the worker. And a secret in a custom
  header (not `Authorization`) follows a redirect from a declared host to another one;
  declare only hosts you trust.
- **What a plugin can read, a malicious plugin could send out.** Its frame can't make
  requests, but a browser can't stop a sandboxed frame from navigating itself to another
  address, which can carry data. Anemo removes a frame the moment it does that (and says
  so on the plugin's page), but that first request has gone. WebRTC is outside the
  Content-Security-Policy too; the frame's startup code removes it, which slows a plugin
  down rather than stopping it. Keep read permissions narrow and install plugins you
  trust; the review shows the code.
- **A plugin's local MCP server runs code that isn't in the package** (for example
  `npx some-server`), which is why the review marks it critical.
- **A trusted computer is the agent's computer.** On a computer marked trusted, with
  acting or PowerShell set to fully autonomous, the agent does what that Windows user
  can, without asking, steered partly by what is on the screen. Keep your own logins,
  files and password manager off it; your own PC belongs on *watched*.
- **Websites that block automated browsers.** Anemo does not try to get around bot
  checks or CAPTCHAs. You can take over the agent's browser yourself, or use an
  official API.
- **A stolen `.env` plus a database dump** reveals the saved keys. Protect both.
- **One user only.** There are no roles; whoever has the password has everything.
  Share links (above) are read-only copies, not accounts.
- **A share link in the wrong hands.** Whoever gets the address can read that copy
  until it expires or you revoke it. It is also kept in the browser history of
  whoever opened it, and in your proxy's access log.

## Reporting a problem

Open an issue at https://github.com/essntl/anemo/issues. For something that
should not be public yet, say only that in the issue and ask for a private way to
send the details.
