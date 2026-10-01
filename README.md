# anemo

**anemo** is a self-hosted, single-user AI workspace and agent operating environment: chat,
autonomous agents with a granular permission system, persistent memory,
documents, files, tasks, calendar and scheduled automations — deployed with
Docker Compose on a homelab.

> Status: phases 0–8 done: login, settings & theming, providers/models with encrypted
> keys, streaming chat run by a background worker (survives reloads and worker
> restarts), chat attachments (images, PDFs, text/code), **Agent mode** with a
> server-enforced permission system and approvals, and a **file manager** plus agent
> file tools with change history and one-click revert. Works on phones and can be
> installed to your home screen. Agents can run **shell commands in an isolated
> sandbox**, follow **agent profiles** and **skills**, have their plans reviewed,
> be paused and resumed, and every run is in the **Runs** history. They can
> **search the web** (SearXNG), read pages and call APIs. Memory, documents etc.
> follow the phases in `docs/architecture.md`.

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

To install it like an app, open anemo in your phone's browser over **HTTPS**
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

Provider changes are security-sensitive: if you logged in more than 15 minutes ago
you will be asked to confirm your password.

### Behind Nginx Proxy Manager

Create a proxy host pointing at `http://<docker-host>:8080` (or at `app:8080` if
you attach the `app` service to NPM's Docker network). Recommended custom config,
so live agent streams are not buffered or cut off:

```nginx
proxy_buffering off;
proxy_read_timeout 1h;
```

Set `PUBLIC_URL` to your public address and `TRUSTED_PROXIES` to NPM's address.

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

Set `ENABLE_FAKE_PROVIDER=true` in `.env` to get a "Fake provider" that answers
without any API key (models `echo`, `reasoning`, `slow`, `agent`); useful for UI
work. The chat end-to-end tests need it added and enabled in Settings, and skip
themselves otherwise (they never fall back to a real model):

```bash
cd e2e && npm install && npx playwright install chromium
E2E_PASSWORD=<your ADMIN_PASSWORD> npx playwright test
```

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
