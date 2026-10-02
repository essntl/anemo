# Anemo

[![Docker Hub](https://img.shields.io/docker/pulls/essntl/anemo?logo=docker&label=Docker%20Hub)](https://hub.docker.com/r/essntl/anemo)

**Anemo** is a self-hosted, single-user AI workspace and agent operating environment: chat,
autonomous agents with a granular permission system, persistent memory,
documents, files, tasks, calendar and scheduled automations — deployed with
Docker Compose on a homelab.

> Status: **1.0**. All phases in `docs/architecture.md` are built: streaming chat run by a
> background worker (survives reloads and restarts), **Agent mode** with a
> server-enforced permission system and approvals, a **file manager**, **documents**,
> **tasks** and a **calendar**, a **memory** you control, a sandboxed **shell**, **web
> search**, a **browser** for agents, **MCP servers**, **sub-agents**, scheduled
> **automations** with **notifications**, **search** across everything and **usage**
> numbers. Works on phones and can be installed to your home screen.

Not built yet: a first-run setup wizard (you add a provider in Settings instead),
the OpenAI *Responses* API (OpenAI works through the chat completions adapter), and
searching inside workspace files that are not documents.

Guides: [deployment](docs/deployment.md) · [backup and restore](docs/backup.md) ·
[security and permissions](docs/security.md) · [architecture](docs/architecture.md)

### Chat vs. Agent mode

**Chat** answers directly and never uses tools. **Agent** may use tools (today:
planning; listing, reading, writing, editing, moving and deleting workspace
files; running shell commands), but every tool call is checked on
the server against **Settings → Agent Permissions**: per category you choose
*Never*, *Always ask*, *Ask for dangerous actions*, *Allowed in workspace* or
*Fully autonomous*. When an action needs approval the run pauses (no worker is held)
and an approval card appears in the chat: *Allow once*, *Allow for this run* (same
kind of action, same folder) or *Deny*. Paths outside the workspace and anything
touching settings or secrets are always refused, whatever the settings say.

### Profiles, skills, plans and runs

**Profiles & Skills** (sidebar) holds reusable agent setups:

- A **profile** has a name, instructions (added to the agent's system prompt), an
  optional model, and optional overrides of the permission levels and limits. Pick
  it in the chat next to the mode switch (Agent mode). A profile can be given more
  autonomy than the global settings, but never more than the global *ceiling*, and
  changing its permissions asks for your password like the settings do.
- A **skill** is a set of instructions for one kind of task. Agents only see its
  name and description until a task needs it; then they load it with a tool. Import
  `SKILL.md`-style files (front matter with `name` and `description`, then Markdown)
  or write your own; export turns them back into such files.

**Plan review** (Settings → Agent Permissions, or per profile): the agent proposes
a plan and waits before taking any action. You can approve it, edit the steps first,
or send it back with feedback. If the agent later changes the steps, it asks again.

**Pause** stops an agent run at the next safe point (the current step finishes,
nothing new starts); no worker is held while it is paused. **Resume** it from the
chat or the run's page, optionally with a message the agent reads first; while a
run is paused you can also edit its plan. Stop cancels it for good.

**Limits** end a run gracefully: steps, tool calls, working time (paused time does
not count), cost (for models with known prices) and failed actions in a row. The
agent then writes a short summary of where it got to. Long conversations are
**compacted**: older steps are summarized by the *Summaries* model (Settings → Providers &
Models) so the agent keeps working within the model's context window. Very long
tool results are shortened for the model; the full text is saved, the agent can
page through it, and you can download it from the run.

**Runs** lists every agent run with its status, profile, time, tokens and cost, and
opens each one with its plan, tool calls, approvals, file changes and answer.

### Sub-agents

An agent can hand a self-contained part of a task to a sub-agent and continue
with its result; several can work at the same time. This is **off by default**:
set *Start sub-agents* in Settings → Agent Permissions to allow it (or to ask
first).

- A sub-agent only gets the task it was given, and may use another agent profile.
- It can never do more than the agent that started it: every action is checked
  against its own permissions and those of every agent above it, and the
  strictest answer wins. If it needs your approval, the request appears inside the
  parent's activity in the chat.
- It works within what the parent had left of its limits (steps, tool calls,
  time, cost), and what it uses is counted against the parent.
- At most 3 sub-agents of one agent work at once, at most 10 per task, and
  sub-agents cannot start their own unless you raise *Sub-agent levels* in the
  limits (up to 3).
- Stopping a run stops its sub-agents.

### Documents

**Documents** are plain Markdown files in the `documents/` folder of your
workspace, so the app, agents, the file manager and any other Markdown tool work
on the same files. Sub-folders are groups; images you drop in go to
`documents/_assets/`.

- **Editor:** rich text (headings, lists, checklists, tables, code blocks, links,
  images) that reads and writes Markdown, or the Markdown source itself. Documents
  using raw HTML or footnotes open as source, because the rich editor would lose
  those.
- **Autosave** about a second after you stop typing. If the file was changed
  somewhere else in the meantime (an agent, another tab), nothing is overwritten:
  you choose which version to keep. With no unsaved changes, outside changes just
  appear.
- **History:** every document keeps its last 50 versions (your autosaves within
  10 minutes count as one), marked as yours, an agent's, or made outside the app.
  Restoring one keeps the current text in the history.
- **Agents** can list, read, search, create and edit documents. Reading follows the
  file-read permission and the folder access for `documents`; writing has its own
  category, *Edit documents* (asks by default). Their changes are in the history
  and can be reverted from the run.
- **Delete** moves the file to the workspace trash (Files → Trash).

### Tasks and calendar

**Tasks** have a status, priority, due date (with an optional time), project and
tags. The list groups them by when they are due (overdue, today, next 7 days,
later, no date); the board shows one column per status and lets you drag cards
between them.

**Calendar** has month, week, day and agenda views. Events can be timed or
all-day and can repeat (daily, weekdays, weekly, every 2 weeks, monthly, yearly,
optionally until a date). For a repeating event you choose whether a change
applies to that one occurrence or the whole series. Tasks with a due date appear
on the calendar too (dashed outline). Click a day to add an event; drag entries to
move them.

Times follow the time zone of your browser. A repeating event keeps its local
time when the clocks change. Tasks without a time, and times given by agents
without a zone, use the time zone from **Settings → General**.

**Reminders** (on events and tasks) arrive as notifications; see below.

**Agents** can list, add, change and delete tasks and events. Changes follow the
*Manage tasks* and *Manage calendar* permissions; deleting counts as a risky
action, so the default level asks you first.

### Notifications

Reminders, the results of automations and messages from agents are listed under
**Notifications** (the bell in the sidebar shows how many are unread). While the
app is open they also pop up as a notice.

In **Settings → Notifications** you choose where else they go:

- **Desktop notifications**: shown by your browser while Anemo is open in a tab
  you are not looking at. This is a per-browser choice and needs HTTPS.
- **Discord**: add a channel's webhook URL (channel settings → Integrations →
  Webhooks) to get notifications on your phone when the app is closed. The URL is
  stored encrypted and never shown again; for each channel you pick which kinds
  of notification it receives. Sending is retried when Discord is unreachable.

Agents can send you a notification themselves (the *Send notifications*
permission); they cannot choose or change where notifications go.

### Automations

An automation is a prompt that an agent runs by itself on a schedule: every
morning, every weekday, every few hours, once, or any cron expression. Times are
wall-clock times in your time zone and stay put when the clocks change.

Each run is a normal agent run in its own conversation (open it from the
automation's **History**), with the permissions of the agent profile you pick.
Because nobody is watching, you choose what happens **when an action would need
your approval**: wait and notify you (default), skip that action and carry on,
or stop the run. It is never approved automatically.

The final answer is sent to you as a notification, and can also be saved as a
document (for example `briefings/{date}`). An automation can keep short notes
between its runs, so "tell me when this page changes" works. Failed runs can be
retried. If the app was off when a run was due, that run is skipped rather than
caught up later, and a run still going when the next one is due is not stacked.

### MCP servers

MCP servers give agents extra tools (GitHub, a database, your smart home, …).
Add them in **Settings → MCP**:

- **Remote servers** are reached by URL (Streamable HTTP, or the older SSE type),
  with optional headers such as an API key.
- **Local servers** are programs (`npx …`, `uvx …`). They run in a separate
  container, the MCP host, which has internet access but no route to the database,
  no workspace and none of the app's secrets. It is off by default; start it with
  `docker compose --profile mcp up -d`.

Headers and environment variables are stored encrypted and never shown again.

Each MCP tool goes through the same permission system as built-in tools. The
*MCP tools* level in Agent Permissions is **Always ask** by default; per tool you
can turn it off, let it run without asking, or never allow it. Servers describe
their tools as read-only or destructive; those are only hints, which you can
correct. If a server later changes a tool, or adds one, it asks every time until
you have looked at it, and runs already in progress do not get the changed tool.

Only add servers you trust: a server sees what agents send to its tools, and its
answers can try to steer the agent.

### Search

Press **Ctrl+K** (⌘K on a Mac) anywhere, or the search button next to *New chat*,
to search everything: chats, documents, memories, tasks, calendar events, files
(by name) and automations. Typing a page name ("calendar", "settings mcp") jumps
there. Arrow keys move, Enter opens.

*All results* opens the search page, where you can filter by kind. Every word you
type has to match. On that page documents and memories are also found by meaning
when an embedding model is set (Settings → Providers & Models); the quick box
matches words only, so typing never calls a model.

### Usage

**Settings → Usage** shows model calls, tokens and cost for a period: totals, a
chart per day, a breakdown by model, kind of work, provider, agent profile or
automation, and every single call. A cost is what the provider reported, or is
worked out from the prices you set for a model; without either it is shown as
*unknown*, never as $0.

### Memory

The assistant remembers things about you across conversations, and everything it
remembers is on the **Memory** page, where you can add, edit, archive and delete it.

- **Say it:** "remember that I prefer TypeScript", "forget where I used to live".
  This works in Chat and Agent mode (the model needs tool support) and is saved at
  once, with a notice and *Undo*.
- **Noticed in conversations:** a few minutes after a chat goes quiet, the *Memory*
  model reads it for lasting facts and preferences. By default these are
  **suggestions** you approve on the Memory page (sidebar badge); in **Settings →
  Memory** you can have them saved automatically, or switch this off.
- **Used when relevant:** for each message, memories that fit it are put into the
  model's context, plus those marked *Always in context* and all *Instructions*.
  A run's page lists which memories it was given.
- **Search by meaning** needs an embedding model (Settings → Providers & Models →
  Embeddings, e.g. `text-embedding-3-small` or a local model in Ollama). Without
  one, memories are found by their words. After changing the model, use *Index all
  memories again* in Settings → Memory.
- Things that look like passwords, keys or tokens are never stored as memories.

Memories are sent to the model provider as part of your messages, like the rest
of the conversation.

### Web search and web pages

Agents can **search the web** through your own [SearXNG](https://docs.searxng.org/)
instance, **read web pages** (main content as Markdown; also PDFs, text and JSON)
and **call HTTP APIs**. Set it up in **Settings → Web & Search**: the SearXNG URL
(or `SEARXNG_URL` in `.env`) with a *Test search* button. SearXNG must allow JSON
output: in its `settings.yml`, `search: formats: [html, json]`.

Whether agents may use these is set per category in Agent Permissions (*Web
search*, *Read web pages*, *External API calls*). Calls other than GET, such as
POST or DELETE, count as moderate risk.

Web pages can't send agents into your network: every connection agents make
(including redirects) is checked against the address it really goes to, and
private, loopback, link-local, CGNAT and cloud-metadata addresses are refused,
as are this server's own containers. To let agents use a service at home (say
Home Assistant), add its host name, IP address or range under **Allowed hosts**.
Page contents are marked as untrusted for the model, but a page can still try to
mislead it, so keep approvals on for anything that changes things.

### Browser

For pages that need JavaScript, clicking or forms, agents can drive a real
headless browser (Chromium): open a page, click, type, scroll and take
screenshots. After each step the agent gets the page as text with a numbered
list of what it can click or type into, and a screenshot of every step is kept
in the run's timeline for you.

The browser runs in its own container, which is off by default. Start it with
`docker compose --profile browser up -d` (about 1.3 GB); agents only get the
browser tools while it is running (Settings → Agent Permissions shows "browser
not running" otherwise). To have it start with everything else, add
`COMPOSE_PROFILES=browser` to your `.env` (or `browser,mcp` for both).

- Each chat has its own private browser, kept open between the agent's turns and
  closed after 30 idle minutes (or with the bin button). Nothing is shared between
  chats, and downloads are refused.
- **You can use that browser too.** The window button in a chat's header shows the
  agent's browser live next to the chat (or in a separate window; on a phone, on its
  own page). Click, type and scroll in it, or enter an address. This is how you log
  in somewhere for the agent, or answer an "are you human" check yourself: the agent
  never tries to get past those, and continues in the same browser afterwards.
- All of the browser's traffic passes a guard inside that container that refuses
  addresses on your own network (your router, NAS, other containers) unless you
  allowed the host in **Settings → Web & Search**. This also holds for redirects,
  embedded content and DNS tricks.
- The *Browser automation* permission is **Always ask** by default. Choosing
  "allow for this run" on the first request covers the rest of that run's
  browsing.

What a page shows is untrusted: it can try to steer the agent, which is why
actions with consequences stay behind your permissions.

### Shell commands

Agents run commands in a separate **sandbox** container (Debian with git, Python,
Node/npm, curl, jq, ripgrep, sqlite3, make), never in the app itself:

- no root and no Linux capabilities, read-only system files, CPU/memory/process
  limits; only the workspace (`/workspace`) and a scratch home folder are mounted;
- **no network at all** by default. A command that needs the internet (package
  installs, `git clone`) runs in a second container, `sandbox-net`, and needs the
  *Shell with network* permission. Note that "internet" includes your LAN;
- neither sandbox can reach the database, Valkey, the app or each other.

Every command is rated *safe*, *moderate* or *dangerous* before it runs (e.g.
`ls` is safe, `npm install` moderate, `rm -rf`, `git push --force` or
`curl … | sh` dangerous), so *Ask for dangerous actions* lets ordinary commands
run and asks you first for the risky ones. Commands stop after 2 minutes by
default (the agent can ask for up to 10). Output streams live into the chat.

**SSH to your servers.** Agents can use `ssh`, `scp` and `rsync` from commands
that have network access. They use their own key, created by the `sandbox-net`
container on first start. Its public half is under **Settings → Agent
Permissions → SSH from agent commands**: add it to `~/.ssh/authorized_keys` on
the server (ideally for a dedicated account, prefixed with
`from="<Docker host IP>"`). Password logins are not possible. For
`ssh host 'command'`, the command that runs on the server is rated too.
`host.docker.internal` is the Docker host itself.

Shell commands can only *start* in folders agents may change, but a running
command can reach every folder in the workspace, and its file changes can't be
reverted with one click like the file tools' changes. Keep private data outside
the workspace, or set *Run shell commands* to *Never*.

### Files

**Files** browses the workspace folder (`WORKSPACE_PATH`): upload, edit text and
code, move, and delete to a trash you can restore from. Saving is refused if the
file changed since you opened it (for example, an agent edited it); you can then
load the other version or overwrite it.

**Settings → Workspace** sets what agents may do in each top-level folder: *Hidden*,
*Read only* or *Read and change*. This applies on top of Agent Permissions.

Every file an agent creates, edits, moves or deletes is listed under **Files
changed** in its answer, with a **Revert** button. Agent deletes go to the trash.

Agents can also look at images in the workspace (PNG, JPEG, GIF, WebP, BMP, TIFF)
when the model supports images. Large images are scaled down first, and the answer
shows a thumbnail of what the agent saw.

### On your phone

The whole app works at phone size: the sidebar becomes a menu (top-left button),
dialogs slide up from the bottom, and on touch screens Enter adds a new line
(send with the arrow button).

To install it like an app, open Anemo in your phone's browser over **HTTPS**
(for example through Nginx Proxy Manager) and choose *Add to Home Screen*
(Safari: Share menu; Chrome: ⋮ menu → *Install app*). It then opens full-screen.
Only the app's own files are cached on the phone, never your chats, files or
settings. If your server can't be reached you get a short offline page. Over
plain HTTP on your LAN it still works, as a normal website.

## Quick start (homelab)

```bash
git clone https://github.com/essntl/anemo.git && cd anemo
cp .env.example .env
# edit .env: APP_SECRET_KEY, POSTGRES_PASSWORD, ADMIN_PASSWORD(_HASH), WORKSPACE_PATH
docker compose up -d
```

Open `http://<server>:8080`, log in, then go to **Settings → Providers & Models**:
add a provider (OpenAI, Anthropic, OpenRouter or any OpenAI-compatible server such
as Ollama), use **Add models** to pick models, and choose a default chat model.

Each model shows what it can do (tools, vision, reasoning, …). OpenRouter reports
this per model. Other providers do not, so Anemo assumes a chat model can use tools
(which Agent mode needs) and guesses the rest from its name. If a provider then
refuses tools, Anemo switches that off for the model by itself. Press a model's
tags to correct any of them by hand.

Provider changes are security-sensitive: if you logged in more than 15 minutes ago
you will be asked to confirm your password.

### ZimaOS / CasaOS (prebuilt images)

Images are on Docker Hub for 64-bit Intel/AMD machines: `essntl/anemo:latest` (app
and worker), `:sandbox` (the shell sandbox), `:browser` (the agents' browser) and
`:mcp-host` (local MCP servers).
[`deploy/zimaos/docker-compose.yml`](deploy/zimaos/docker-compose.yml) uses them
and needs no `.env` file:

1. Open the file and replace every `CHANGE_ME` (the comments at the top say what
   goes where), and set `PUBLIC_URL` to your ZimaOS address with port `8484`.
2. From a terminal on the server, save it as `/DATA/AppData/anemo/docker-compose.yml`
   and run `docker compose up -d` in that folder.
3. Open `http://<your-zimaos-address>:8484` and log in.

Update with `docker compose pull && docker compose up -d` in the same folder.

Installing through the ZimaOS screen (App Store → **+** → *Install a customized
app* → *Import*) is possible, but ZimaOS rewrites the file and keeps only one
network per service, which cuts the worker off from the sandbox, the browser and
the MCP host. The terminal keeps the file as written.

Data is kept in `/DATA/AppData/anemo` (workspace, uploads, database).

### Behind Nginx Proxy Manager

Create a proxy host pointing at `http://<docker-host>:8080` (or at `app:8080` if
you attach the `app` service to NPM's Docker network). Recommended custom config,
so live agent streams are not buffered or cut off:

```nginx
proxy_buffering off;
proxy_read_timeout 1h;
```

Set `PUBLIC_URL` to your public address and `TRUSTED_PROXIES` to NPM's address.

### Backups

```bash
sh scripts/backup.sh            # database, uploads and workspace into ./backups/
sh scripts/restore.sh backups/anemo-<date>-<time>
```

Keep a copy of `.env` as well: saved API keys are encrypted with `APP_SECRET_KEY`.
Details, nightly backups and moving to another machine: [docs/backup.md](docs/backup.md).

### Is everything running?

**Settings → Advanced** shows the version, a check of every part (database, live
events, worker, folders, browser) and the security log. What happens when a part
is down is listed in [docs/deployment.md](docs/deployment.md).

## Services

| Service    | Purpose                                              |
|------------|------------------------------------------------------|
| `app`      | FastAPI API + the built web UI (only published port) |
| `worker`   | Runs chat/agent jobs, automations and indexing       |
| `postgres` | PostgreSQL 17 + pgvector — all durable state         |
| `valkey`   | Live event streams and control signals (ephemeral)   |
| `migrate`  | Applies database migrations, then exits              |
| `sandbox`  | Runs agent shell commands, with no network            |
| `sandbox-net` | Runs agent shell commands that need the internet   |
| `browser`  | Optional (`--profile browser`): a browser agents can drive |
| `mcp-host` | Optional (`--profile mcp`): runs local MCP servers    |

## Development

Requires Docker and Node 22. On Windows, a WSL2 checkout is strongly recommended
(the Makefile needs `make`, which Git Bash does not include).

```bash
make dev            # hot reload; UI at http://localhost:5173
make test           # backend (in container) + frontend checks
make lint
make revision m="describe change"   # new Alembic migration
make gen-api        # regenerate frontend API types after backend changes
```

End-to-end tests run against a throwaway copy of the app (its own containers,
port 8090, volumes and passwords) with a scripted "fake" model, so nothing real
is touched and no model is called:

```bash
cd e2e && npm install && npx playwright install chromium && cd ..
sh e2e/run-isolated.sh              # start, test, remove
KEEP=1 sh e2e/run-isolated.sh       # leave it running to look around
E2E_BROWSER=1 sh e2e/run-isolated.sh  # also test the agents' browser
```

You can also point the tests at a running install
(`cd e2e && E2E_PASSWORD=<password> npx playwright test`). Tests that need a model
only run if the fake provider (`ENABLE_FAKE_PROVIDER=true`) is added there, and skip
themselves otherwise; they never fall back to a real model.

The `mobile` project repeats the key flows on a phone-sized touch screen
(`npx playwright test --project mobile`). App icons are generated from one SVG by
`e2e/scripts/make-icons.cjs`.

How a chat turn flows: the API stores the message and queues a job → the worker
streams the model's answer into a Redis stream → the browser follows it over SSE
(`/api/runs/{id}/events`) and can reconnect at any time. Stopping a run cancels
it inside the worker. See `docs/architecture.md` sections F, K and L.

Frontend: React + TypeScript + Vite + Tailwind v4. Colors are semantic tokens
(`bg-surface`, `text-muted`, `bg-accent`) defined in
`frontend/src/styles/tokens.css`; never use raw colors in components.
