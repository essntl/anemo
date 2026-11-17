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

Open `http://<server>:8080` and log in. Go to **Settings → Providers & Models**, add a
provider, add models, and pick a default chat model. Until a default is chosen the
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

## ZimaOS / CasaOS

See the README section *ZimaOS / CasaOS* and
[`deploy/zimaos/docker-compose.yml`](../deploy/zimaos/docker-compose.yml): one file
with prebuilt images, no `.env` needed. That file has no profiles: the browser, the
MCP host and the Claude runner are always started, so where the app suggests a
command with `--profile …`, plain `docker compose up -d` does the same.

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

Create a proxy host for `http://<docker-host>:8080` (port `8484` with the ZimaOS
file) with this custom configuration,
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

About once a day the worker asks GitHub's API how many commits `main` has that this
build doesn't (`compare/<commit>...main`) and Settings → Advanced shows them. Switch
it off there, or with `UPDATE_CHECK=false` in `.env`; `UPDATE_REPO` (default
`essntl/anemo`) points it at another repository. Nothing is ever installed by itself.

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

## Where the data lives

| What | Where |
|---|---|
| Conversations, settings, tasks, memory, everything structured | Docker volume `pgdata` |
| Uploads, saved tool outputs, undo copies | Docker volume `appdata` (`/data` in the app) |
| Your files and documents | The folder in `WORKSPACE_PATH` |
| Encryption key and passwords | `.env` (not part of any backup made by the scripts) |
