# Deployment

Anemo runs as a small set of Docker containers. Only one port is published
(the web UI and API); everything else talks over private Docker networks.

## What you need

- A Linux machine (or ZimaOS / CasaOS) with Docker and the Compose plugin.
- About 2 GB of free memory for the base stack. The optional browser adds up to 2 GB.
- A folder for your files (the *workspace*). Agents work inside it and nowhere else.

## Install from source

```bash
git clone https://github.com/essntl/anemo.git && cd anemo
cp .env.example .env
```

Edit `.env`. Four settings are required:

| Setting | What to put there |
|---|---|
| `APP_SECRET_KEY` | A long random string: `openssl rand -hex 32`. It encrypts saved API keys. **Keep a copy**: without it, saved keys cannot be read after a restore. |
| `POSTGRES_PASSWORD` | Any random string. Only the containers use it. |
| `ADMIN_PASSWORD_HASH` | Your login password, hashed: `docker compose run --rm app python -m app.cli hash-password`. (`ADMIN_PASSWORD` in plain text also works, with a warning in the log.) |
| `WORKSPACE_PATH` | The folder on the host that holds your files, e.g. `/srv/anemo`. |

Also set `PUBLIC_URL` to the address you will open in the browser, and
`COOKIE_SECURE=false` if that address is plain `http://` (for example on your LAN
without a proxy). With `COOKIE_SECURE=true` over plain HTTP the login will not stick.

Then:

```bash
docker compose up -d
```

Open `http://<server>:8080` and log in. The first time, a short setup opens (see
[First-time setup](#first-time-setup) below). Until a default chat model is chosen the
message box stays disabled and tells you so.

### Optional parts

| Part | Start it with | What it adds |
|---|---|---|
| Browser | `docker compose --profile browser up -d` | Agents can open pages, click and type in a real browser. About 1.3 GB image. |
| MCP host | `docker compose --profile mcp up -d` | Runs local MCP servers (`npx …`, `uvx …`). Remote MCP servers by URL do not need it. |
| Claude runner | `docker compose --profile claude up -d` | Your Claude subscription (Pro or Max) as a model provider. See [claude-code.md](claude-code.md). |

To keep them on after every `docker compose up -d`, put `COMPOSE_PROFILES=browser,mcp`
in `.env` (add `claude` for the Claude runner).

Web search needs a SearXNG instance of your own with the JSON format enabled; set
its address in **Settings → Web & Search**.

## First-time setup

The first time you log in, a short **setup** opens:

1. **Model provider**: add one (OpenAI, Anthropic, OpenRouter, any OpenAI-compatible
   server such as Ollama, or your Claude subscription), use **Add models** to pick its
   models, and choose the model for chats.
2. **Helper models** (optional): Summaries, Memory and Embeddings, with suggestions
   from the models you added (a small model for the first two).
3. **You**: your time zone, and whether Anemo opens on Home or a new chat.
4. **Optional parts**: whether the sandboxes, the browser, the MCP host, the Claude
   runner and SearXNG are running, and for each one that isn't, the command that
   starts it.
5. **Notifications** (optional): push on this device, or a Discord channel.

Every step can be skipped, and **Not now** leaves it for later: it then waits in
**Settings → Advanced** (*Continue setup*), and the step you left off at is kept, also
for another device. You can go through it again there after finishing. It sets
nothing you couldn't set in Settings yourself; an install that already has a
provider never sees it on its own.

Each model shows what it can do (tools, vision, reasoning, …). OpenRouter reports
this per model. Other providers do not, so Anemo assumes a chat model can use tools
(which Agent mode needs) and guesses the rest from its name. If a provider then
refuses tools, Anemo switches that off for the model by itself. Press a model's
tags to correct any of them by hand.

Provider changes are security-sensitive: if you logged in more than 15 minutes ago
you will be asked to confirm your password.

## Prebuilt images

Images for 64-bit Intel/AMD and ARM machines (x86-64 and ARM64: Apple Silicon,
Raspberry Pi 4/5, ARM servers) are built from `main` on every change and published to
GitHub's registry: `ghcr.io/essntl/anemo:latest` (app and worker),
`ghcr.io/essntl/anemo-sandbox` (the shell sandbox), `-browser` (the agents' browser),
`-mcp-host` (local MCP servers) and `-claude-runner` (the Claude subscription
provider). Older builds are also on Docker Hub (`essntl/anemo`).

### Prebuilt images, no build

[`docker-compose.prebuilt.yml`](../docker-compose.prebuilt.yml) runs Anemo from the
images on GitHub's registry (x86-64 and ARM64) with no checkout, no build and no
`.env`. Save it in a folder of its own as `docker-compose.yml`, replace every
`CHANGE_ME` (the comments at the top say what goes where), then run
`docker compose pull && docker compose up -d` there and open `http://<server>:8484`.
Your data is kept next to the file (`workspace/`, `data/`, `postgres/`).

## ZimaOS / CasaOS

[`deploy/zimaos/docker-compose.yml`](../deploy/zimaos/docker-compose.yml) uses the
prebuilt images and needs no `.env` file:

1. Open the file and replace every `CHANGE_ME` (the comments at the top say what
   goes where), and set `PUBLIC_URL` to your ZimaOS address with port `8484`.
2. From a terminal on the server, save it as `/DATA/AppData/anemo/docker-compose.yml`
   and run `docker compose up -d` in that folder.
3. Open `http://<your-zimaos-address>:8484` and log in.

Update with `docker compose pull && docker compose up -d` in the same folder
(Settings → Advanced tells you when there is something new; see
[Updating](#updating)).

Installing through the ZimaOS screen (App Store → **+** → *Install a customized
app* → *Import*) is possible, but ZimaOS rewrites the file and keeps only one
network per service, which cuts the worker off from the sandbox, the browser, the
MCP host and the Claude runner. The terminal keeps the file as written.

Data is kept in `/DATA/AppData/anemo` (workspace, uploads, database).

That file has no profiles: the browser, the MCP host and the Claude runner are always
started, so where the app suggests a command with `--profile …`, plain
`docker compose up -d` does the same.

## More than one copy on a server

Anemo has one user, so each person gets their own copy. Copy the ZimaOS file into a
new folder (for example `/DATA/AppData/anemo-2`) and change, so nothing clashes:

- `name:` at the top (for example `anemo-2`): container, volume and network names
  start with it;
- the published port (`"8485:8080"`, and `port_map` at the bottom);
- every `/DATA/AppData/anemo/` path to the new folder;
- `APP_SECRET_KEY`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, the database password and
  `PUBLIC_URL`: each copy has its own.

Each copy makes seven Docker networks, and Docker only has room for about 30 with
automatic addresses, shared with every other app on the server. When they run out,
`docker compose up -d` stops with *all predefined address pools have been fully
subnetted*. Give the copy its own small address ranges instead: replace the
`networks:` block at the bottom of its file with the one below, using a different
third number for each copy (`10.84.2.x`, `10.84.3.x`, …; pick another prefix if your
home network itself uses `10.84`).

```yaml
networks:
  core:
    ipam:
      config:
        - subnet: 10.84.2.0/28
  sandbox_int:
    internal: true
    ipam:
      config:
        - subnet: 10.84.2.16/28
  sandbox_net_int:
    internal: true
    ipam:
      config:
        - subnet: 10.84.2.32/28
  mcp_int:
    internal: true
    ipam:
      config:
        - subnet: 10.84.2.48/28
  browser_int:
    internal: true
    ipam:
      config:
        - subnet: 10.84.2.64/28
  claude_int:
    internal: true
    ipam:
      config:
        - subnet: 10.84.2.80/28
  egress:
    ipam:
      config:
        - subnet: 10.84.2.96/28
```

If a start already failed with that error, run `docker compose down` in the copy's
folder first (it removes the networks that were made), then `docker compose up -d`.
A copy that already runs keeps the addresses it has and needs no change.

## Behind Nginx Proxy Manager

Create a proxy host for `http://<docker-host>:8080` (port `8484` with the prebuilt or
ZimaOS file; or `app:8080` if you attach the `app` service to NPM's Docker network)
with this custom configuration,
so live answers are not buffered or cut off:

```nginx
proxy_buffering off;
proxy_read_timeout 1h;
```

Then in `.env`: `PUBLIC_URL=https://your.domain`, `COOKIE_SECURE=true`, and
`TRUSTED_PROXIES=<address of the proxy>` so the login rate limit sees the real
client address.

The web app needs no WebSockets. The browser extension (Anemo Companion, `extension/`)
does: its live connection is one WebSocket at `/api/extension/ws`. If you use the
extension, switch on **Websockets Support** for the proxy host in Nginx Proxy Manager.
Cloudflare passes WebSockets through on every plan; the extension sends a ping every 20 s,
well inside Cloudflare's 100-second idle limit.

Anemo has one user and one password. Do not expose it to the internet without
HTTPS; an extra access list or VPN in front is a good idea.

## Checking that it is healthy

- `docker compose ps` — every service should be `healthy` (`migrate` exits after it
  has run).
- **Settings → Advanced** shows the version, the commit it was built from, and a
  check of each part: database, live events, background worker, workspace folder,
  data folder, the two sandboxes, browser, MCP host, Claude runner and SearXNG.
- `curl http://<server>:8080/api/health` answers `{"status":"ok"}`.

## Updating

From a checkout:

```bash
git pull
APP_COMMIT=$(git rev-parse HEAD) docker compose up -d --build
```

(`make up` does the same.) `APP_COMMIT` lets Anemo know which version runs, for the
update notice; without it everything works, but Settings → Advanced can't tell
whether there is something newer. With the prebuilt images (ZimaOS):
`docker compose pull && docker compose up -d`. The images carry their commit.

Anemo has no numbered releases: the images are rebuilt from `main` on every change,
and each build records the commit it was made from. About once a day the worker asks
GitHub's API how many commits `main` has that this build doesn't
(`compare/<commit>...main`). When there are some, **Settings → Advanced** lists them
(newest first) with the command that updates your kind of install, and Home's **Needs
you** shows *An Anemo update is available* until you put it away (*Not now*; it comes
back a week later if there are newer changes). After you update, a **What's new** card
lists what changed since the version you had, once.

The check is one request to GitHub's API that carries nothing about you (no cookies,
no ids, a fixed User-Agent). Switch it off in Settings → Advanced, or for good with
`UPDATE_CHECK=false` in `.env`; `UPDATE_REPO` (default `essntl/anemo`) points it at
another repository, such as your fork. Nothing is ever installed by itself.

**Installed from a checkout before the project was renamed?** The compose project
used to be called `ai-workspace`, and Docker names the volumes after it
(`ai-workspace_pgdata`, …). It is now `anemo`, so an update would start with new,
empty volumes. To keep using your existing ones, add this line to `.env` before
you update (your data is untouched either way):

```
COMPOSE_PROJECT_NAME=ai-workspace
```

Database changes are applied automatically by the `migrate` service before the app
starts. Make a backup first (see [backup.md](backup.md)); going back to an older
version after the database was upgraded means restoring that backup.

## When something is down

| What is down | What happens |
|---|---|
| Worker | Messages wait in the queue and are answered when it is back. A run that was interrupted continues from its last saved step; a tool call that was in progress is reported to the model as interrupted and is not repeated on its own. |
| Valkey (live events) | Answers still arrive, but in steps every couple of seconds instead of word by word. Stop still works. Nothing is lost: Valkey holds no durable data. |
| Database | The app answers with errors until it is back. No state is lost. |
| Model provider | The call is retried, then fallback models are tried, then the run fails with a clear message and a retry button. |
| Browser / MCP host / SearXNG | Only the tools that need them fail, with a message that says why. |
| Nobody answers an approval | It expires after 24 hours and counts as denied; the agent carries on without that action. |

## Services

| Service    | Purpose                                              |
|------------|------------------------------------------------------|
| `app`      | FastAPI API + the built web UI (only published port) |
| `worker`   | Runs chat/agent jobs, automations and indexing       |
| `postgres` | PostgreSQL 17 + pgvector — all durable state         |
| `valkey`   | Live event streams and control signals (ephemeral)   |
| `migrate`  | Applies database migrations, then exits              |
| `sandbox`  | Runs agent shell commands, with no network           |
| `sandbox-net` | Runs agent shell commands that need the internet  |
| `browser`  | Optional (`--profile browser`): a browser agents can drive |
| `mcp-host` | Optional (`--profile mcp`): runs local MCP servers   |
| `claude-runner` | Optional (`--profile claude`): Claude Code sessions for the Claude subscription provider |

## Where the data lives

| What | Where |
|---|---|
| Conversations, settings, tasks, memory, everything structured | Docker volume `pgdata` |
| Uploads, saved tool outputs, undo copies | Docker volume `appdata` (`/data` in the app) |
| Your files and documents | The folder in `WORKSPACE_PATH` |
| Encryption key and passwords | `.env` (not part of any backup made by the scripts) |
