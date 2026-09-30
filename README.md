# anemo

**anemo** is a self-hosted, single-user AI workspace and agent operating environment: chat,
autonomous agents with a granular permission system, persistent memory,
documents, files, tasks, calendar and scheduled automations — deployed with
Docker Compose on a homelab.

> Status: phases 0–6 done: login, settings & theming, providers/models with encrypted
> keys, streaming chat run by a background worker (survives reloads and worker
> restarts), chat attachments (images, PDFs, text/code), **Agent mode** with a
> server-enforced permission system and approvals, and a **file manager** plus agent
> file tools with change history and one-click revert. Works on phones and can be
> installed to your home screen. Agents can run **shell commands in an isolated
> sandbox**. Web search, memory, documents etc. follow the phases in
> `docs/architecture.md`.

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
