# anemo

**anemo** is a self-hosted, single-user AI workspace and agent operating environment: chat,
autonomous agents with a granular permission system, persistent memory,
documents, files, tasks, calendar and scheduled automations — deployed with
Docker Compose on a homelab.

> Status: milestone 1 complete: login, settings & theming, providers/models with
> encrypted keys, and streaming chat executed by a background worker (survives page
> reloads and worker restarts). Agents, tools, memory, documents etc. follow the
> phases in `docs/architecture.md`.

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
without any API key (models `echo`, `reasoning`, `slow`); useful for UI work and
required by the end-to-end tests:

```bash
cd e2e && npm install && npx playwright install chromium
E2E_PASSWORD=<your ADMIN_PASSWORD> npx playwright test
```

How a chat turn flows: the API stores the message and queues a job → the worker
streams the model's answer into a Redis stream → the browser follows it over SSE
(`/api/runs/{id}/events`) and can reconnect at any time. Stopping a run cancels
it inside the worker. See `docs/architecture.md` sections F, K and L.

Frontend: React + TypeScript + Vite + Tailwind v4. Colors are semantic tokens
(`bg-surface`, `text-muted`, `bg-accent`) defined in
`frontend/src/styles/tokens.css`; never use raw colors in components.
