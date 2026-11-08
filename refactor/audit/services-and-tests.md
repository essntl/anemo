# Anemo audit: side services, deployment, tests, security

Read-only audit of the repository at `main` 7c4e988. No repo file was changed.
Baseline (from `(scratch)`): backend 783 passed, 82.8% line coverage; frontend 43 files / 197 tests passed; ruff, mypy, format, tsc, oxlint and build clean. `alembic check` failed only because that run had no APP_SECRET_KEY (an environment problem, not a code bug).

---

## 0. Serious and notable issues (most important first)

| # | Severity | Where | Issue | Suggested fix |
|---|---|---|---|---|
| S1 | **Medium (privacy / repo hygiene)** | `dump.rdb` (24 KB, added in commit `7d0d29f`, PR #1 "Use a Claude subscription through Claude Code") | A Redis/Valkey RDB snapshot (format `REDIS0010`, redis-ver 7.0.15) is committed. It holds about **30 `run:<uuid>` event streams plus `events:global`**: run status events (`running`/`succeeded`), model labels ("Claude Opus 5.5 (subscription) · Max"), compressed message/text-delta events with **real chat content from a dev session** (test prompts and answers), and file/attachment-related events. A grep found **no API keys, tokens, passwords or bearer strings** in it. Production Valkey runs with `--save ""` (`docker-compose.yml:92`), so the file almost certainly came from a local `valkey-server`/`redis-server` started in the repo root. | `git rm dump.rdb`, add `*.rdb` to `.gitignore`. If that chat content is private, rewrite history (filter-repo) before more forks or clones spread it. |
| S2 | **Medium (isolation claim is wrong)** | `docker-compose.yml:182,214,245,294`; same in `deploy/zimaos/docker-compose.yml:255,283,311,348`; claims in `docs/security.md:187`, `docker-compose.yml:251-252`, `claude-runner/runnerd/app.py:3-4` | `sandbox-net` (agent shell with network), `mcp-host` (runs arbitrary `npx`/`uvx` code), `browser` (renders arbitrary web pages) and `claude-runner` all share one non-internal `egress` network. Each daemon listens on `0.0.0.0`, so any of these containers can reach the others by service name: `sandbox-net:7070`, `mcp-host:7080`, `browser:7090`, `claude-runner:7100`. Only the bearer token separates them (the token volumes are mounted correctly, so an attacker does not get the tokens directly). The `/health` endpoints need no token (the runner's even starts `claude auth status`). The docs say "Only the worker can reach the runner (internal network plus a token)", which is false. | Give each service its own egress network (for example `egress_sandbox`, `egress_mcp`, ...), or bind the daemons only to the internal interface. Fix the docs. |
| S3 | **Medium (defense in depth)** | `docker-compose.yml:9-43,100-157` (x-backend: `migrate`, `app`, `worker`); zimaos `:132-198` | The containers that hold every secret (`APP_SECRET_KEY` and `DATABASE_URL` in env, the provider keys after decryption) have **no hardening**: no `cap_drop`, no `no-new-privileges`, no `read_only`, no `pids_limit` or memory limits. The sandbox, mcp-host, browser and runner all have these. The worker also joins all six networks. | Add `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, `read_only: true` with tmpfs `/tmp`, and limits to x-backend. |
| S4 | **Medium (TOCTOU / docs overclaim)** | `backend/app/workspace/fs_guard.py:22-35`; `docs/architecture.md:518` | The docs say paths are "re-checked after open (`O_NOFOLLOW` on final component)". **No `O_NOFOLLOW` exists anywhere in the code.** `resolve()` checks with `Path.resolve()`, and later `open()` follows symlinks. Agent shell commands write to the same workspace mount, so an agent can swap a checked file or folder for a symlink between the check and the open. File tools in the worker could then read outside the workspace (for example `/proc/self/environ`, which holds APP_SECRET_KEY and DATABASE_URL, or `/data/uploads`), or write outside it (zip unpack in `tools/builtin/file_exchange.py:429-470`, file writes). The race is hard to win, but the docs promise the guard exists. | Open with `os.open(..., O_NOFOLLOW)` plus `openat`-style per-component checks (or check `fstat` against `lstat` after open). Correct the doc. |
| S5 | **Medium (unsafe default)** | `deploy/zimaos/docker-compose.yml:56-67,110,147` | The ZimaOS template ships `ADMIN_PASSWORD: "CHANGE_ME"`, `COOKIE_SECURE: "false"` and port `8484` on all interfaces. Only `APP_SECRET_KEY` is refused at startup (length < 32, `core/config.py:75-82`). A user who replaces the secret key but forgets the password gets an instance that accepts admin / CHANGE_ME. The plaintext-password warning (`auth/service.py:168-177`) only logs. | Refuse to start (or refuse login) when ADMIN_PASSWORD is `CHANGE_ME`, empty or shorter than N characters. |
| S6 | Low-Medium (path traversal, authenticated) | `backend/app/features/documents/service.py:396-401`, called from `documents/router.py:149-152` | `unique_path(folder, title)` calls `base.mkdir(parents=True)` on `root/documents/<folder>` **before any validation**. `folder` comes straight from `POST /api/documents` (`CreateIn.folder`, max 500 characters). With `folder="../../data/x"` the app creates folders outside the workspace wherever the app user can write. `files.rel()` then raises a `ValueError` and the response is a 500. No file is written, because `create()` runs `check_path`. | Run the `check_path`-style part validation (no `..`, no leading dot, no `assets`) or `fs_guard.resolve()` on the folder before `mkdir`. |
| S7 | Low-Medium | `README`/`.env.example:36-38` advise `TRUSTED_PROXIES=172.16.0.0/12`; compose sets `FORWARDED_ALLOW_IPS` from it (`docker-compose.yml:32`); `sandbox-net` has `host.docker.internal:host-gateway` (`:175-176`) | With the advised CIDR, uvicorn trusts `X-Forwarded-For` from any Docker bridge address. An agent command in `sandbox-net` can call the published app port through the host gateway (source 172.x) and fake its client IP. That gets around the per-IP login limit and the share/push miss counters, and fakes audit IPs (the global limit still applies). | Advise the reverse proxy's exact address or network. Or don't publish the app on the bridge gateway, or leave `host-gateway` off by default. |
| S8 | Low | `browser/browserd/app.py:98-105` | Chromium starts without its own sandbox: Playwright's default `chromium_sandbox=False` passes `--no-sandbox`. A renderer exploit runs as the `browser` user in a container on `egress`. Its traffic then skips the guard proxy and can reach the LAN directly, and it shares `browser_int` with the app. | Launch with `chromium_sandbox=True` (needs a seccomp profile or user namespaces), or put the browser container on an egress network that drops RFC1918 at the firewall. |
| S9 | Low | `backend/app/main_api.py` (no security headers) | No CSP, `X-Frame-Options`/`frame-ancestors` or `X-Content-Type-Options: nosniff` on the SPA or the API. Clickjacking of "Allow once" is mostly blocked by `SameSite=Lax` (no cookie is sent in a cross-site iframe), but nosniff and frame-ancestors are cheap to add. | Add a small headers middleware. |
| S10 | Low | `backend/app/features/auth/service.py:26-28,77-97` | A global counter (`login:fail:all`, 30 per minute) lets anyone on the internet lock the owner out, renewing the block every minute. The check runs before the increment, so parallel requests can go past the limit. | Accept the trade-off and document it, or exempt known-good IPs/sessions. Use `INCR` first and compare after. |
| S11 | Low | `backend/app/features/shares/service.py:278,339` | Share tokens are stored and looked up in **plaintext**, while session tokens (`auth/service.py:39-40`) and push action tokens are stored as SHA-256. A DB dump alone is enough to open every live share. | Store `sha256(token)`; show the raw token only once (or keep both during a migration). |
| S12 | Info | `backend/app/features/notifications/push_router.py:72-97` | A push "Allow once" approves a waiting tool call with no session, by design (256-bit token, single use). Anyone holding the unlocked phone, or seeing the lock-screen notification with actions, can approve. | Document it; perhaps offer "push buttons only for low-risk actions". |

**Git history secret scan** (`git log -p --all` for `sk-…`, `ghp_`, `github_pat_`, `BEGIN … PRIVATE KEY`, `AKIA…`, `xox?-`, `AIza…`, `password=`/`secret=`/`token=` literals, Discord webhook URLs): **no real secrets found.** Only test fixtures turned up: `sk-test-PROVIDERKEY-0123456789` (backend/tests/api/test_failures.py), `https://discord.com/api/webhooks/1/WEBHOOKTOKEN-0123456789` and `/123/very-secret-token` (test_failures.py, test_notifications_automations.py), `sk-or-v1-supersecret1234` (test_providers.py/test_mcp.py), `hunter2`/`sk-abcdef…` (test_memory.py), `CHANGE_ME` placeholders, and CI's `openssl rand` values. `.env` was never committed; the only sensitive-looking file ever added is `dump.rdb`. `__pycache__/*.pyc` files exist in the working tree (`sandbox/execd/__pycache__`, …) but are git-ignored and not tracked.

---

## A. Side services and deployment

### A.1 Services, endpoints, auth

All four daemons follow the same pattern. Each is a FastAPI app with docs/openapi switched off, run by uvicorn with `--no-access-log` under tini, as a non-root PUID/PGID user, in its own `/opt/<svc>` venv. At start it makes a random `secrets.token_urlsafe(32)` and writes it atomically (`.tmp` + chmod 600 + replace) to a token file on a named volume that only that service (read-write) and the worker (read-only; the app too for the browser) mount. If an `<X>_TOKEN` env var is set, the file is not written (used by tests).

**sandbox / sandbox-net — execd** (`sandbox/execd/app.py`, port 7070, one image for two services)
| Method | Path | Line | What |
|---|---|---|---|
| POST | `/exec` | 240 | `{"id","command","cwd","timeout_s"<=3600}` → `bash -c` in its own process group, clean env (`_command_env` :125), NDJSON stream of stdout/stderr chunks (1 MiB cap per stream) then an `exit` event |
| DELETE | `/exec/{exec_id}` | 249 | SIGTERM the group, SIGKILL after 5 s |
| GET | `/health` | 257 | `{"status":"ok"}`, no auth |
- Auth: `_check_auth` :103 strips the `"Bearer "` prefix, then `compare_digest`. Token: `EXECD_TOKEN_FILE` (default `/run/execd/token`). Volumes `sandbox-token` / `sandbox-net-token`; the worker reads `/run/sandbox-token/{sandbox,sandbox-net}/token`.
- `EXECD_SSH=1` (sandbox-net only) creates `~/.ssh/id_ed25519` and an ssh config (:70-90). The key volume `sandbox-ssh` is mounted read-only into the app so Settings can show the public key.
- Backend caller: `backend/app/sandbox_client.py` — `_connection(network)` :42 (URL + token file, `override` hook for tests), `run_command` :58 (streams, maps 401 → `SandboxUnavailable`, on cancel calls `_stop` :113 → `DELETE /exec/{id}`). Used by `tools/builtin/shell.py:136` (cwd goes through `fs_guard`, timeout clamped to `limits.max_shell_timeout_s`).

**mcp-host — hostd** (`mcp-host/hostd/app.py`, port 7080, profile `mcp`)
| Method | Path | Line | What |
|---|---|---|---|
| GET | `/health` | 171 | `{"status","servers":n}`, no auth |
| POST | `/tools` | 180 | `{"server":{id,command,args,env}}` → starts or reuses a stdio MCP server, lists up to 20 pages of tools |
| POST | `/call` | 206 | `{"server", "name", "arguments", "timeout_s"<=600}` → tool result dump |
| DELETE | `/servers/{server_id}` | 222 | stop the server process |
- Auth: `_check_auth` :165 compares the **whole header** with `"Bearer <token>"` (differs from execd/runner). Token `HOSTD_TOKEN_FILE` (`/run/hostd/token`), volume `mcp-host-token`, worker `/run/mcp-host-token/token`.
- A server is restarted when its fingerprint (command+args+env sha256) changes. At most 20 servers; idle ones (`HOSTD_IDLE_STOP_S`, 1800 s) are stopped only lazily, when the next `_client_for` call happens.
- Backend caller: `backend/app/mcp/client.py` — `_host()` :160, `_host_post()` :174, `list_tools` :213 → `/tools`, `call_tool` :226 → `/call`. Remote (http/sse) MCP servers are reached directly from the worker. **`DELETE /servers/{id}` is never called by the backend** (bug B7).

**browser — browserd** (`browser/browserd/app.py` + `guard.py` + `snapshot.js`, port 7090, profile `browser`)
| Method | Path | Line | What |
|---|---|---|---|
| GET | `/health` | 195 | `{"status","sessions":n}`, no auth |
| POST | `/sessions/{id}/act` | 275 | agent action open/read/click/type/screenshot → snapshot (url, title, text, elements with refs) + JPEG + `blocked_hosts` |
| GET | `/sessions/{id}/view` | 324 | user view (screenshot, url, title); 404 when there is no session |
| GET | `/sessions/{id}/stream` | 423 | SSE: CDP screencast `frame`, `meta` every 1 s, `closed` |
| POST | `/sessions/{id}/input` | 452 | user click/type/key/scroll/open/back/reload |
| DELETE | `/sessions/{id}` | 489 | close the context and the proxy |
- Auth: full-header compare (:189). Token `BROWSERD_TOKEN_FILE` (`/run/browserd/token`), volume `browser-token`, mounted read-only in **app and worker**. The token file is deleted on shutdown (:181-183), so "no file" means "not running"; the other daemons don't do this.
- Each session gets its own browser context and a `GuardProxy` on 127.0.0.1 (`guard.py:118`). The guard resolves names itself, blocks non-global IPs (v4-mapped handled) unless allow-listed, connects to exactly the checked IP, CONNECT for https, origin-form rewrite for http. Downloads are off and service workers blocked; WebRTC non-proxied UDP and QUIC are disabled. At most `BROWSERD_MAX_SESSIONS` (4) sessions; idle close (`BROWSERD_IDLE_CLOSE_S`) is lazy.
- Backend caller: `backend/app/browser_client.py` — `available()` :33, `_connection()` :38, `act` :51, `view` :110, `stream` :125, `user_input` :148, `close` :163. The app uses it in `features/browser_router.py` (`/api/conversations/{id}/browser[...]`, `/api/browser/status`), and the worker uses it from the browser tool. The session id is the conversation UUID.

**claude-runner — runnerd** (`claude-runner/runnerd/{app,sessions,launch,cli_exec}.py`, port 7100, profile `claude`)
| Method | Path | Line | What |
|---|---|---|---|
| POST | `/sessions/{key}/turn` | 222 | one model step, NDJSON (`session`, `accepted`, text/thinking/tool events, `end`/`error`) |
| POST | `/sessions/{key}/interrupt` | 231 | interrupt the CLI |
| DELETE | `/sessions/{key}` | 239 | end the process (**never called by the backend**) |
| POST | `/oneshot` | 264 | stateless request (titles, summaries), no tools, no persistence |
| GET | `/health` | 284 | `{ok, logged_in, auth_method, cli_version, subscription, message}`, cached 30 s, no auth, runs `claude --version` and `claude auth status --json` |
- Auth: strips the prefix like execd (:91). Token `RUNNER_TOKEN_FILE` (`/run/claude-runner/token`), volume `claude-runner-token`, worker `/run/claude-runner-token/token`.
- The CLI is pinned (claude-agent-sdk 0.2.172 bundles Claude Code 2.1.308; the build fails if the version differs). `cli_exec.py`, installed as `/usr/local/bin/claude`, rebuilds the env from an allowlist and always drops `ANTHROPIC_*`, `CLAUDE_CODE_OAUTH*`, `APP_SECRET*`, `DATABASE_*`, `POSTGRES*` (`launch.py:88-132`). The CLI gets no built-in tools, strict MCP config with only the in-process `anemo` bridge, no setting sources, verbatim prompts. Tool calls are "parked" until the worker posts the results.
- Backend caller: `backend/app/claude_runner_client.py` — `_connection()` :41, `_stream()` :55, `turn()` :75 (key `conv:<uuid>:chat` etc. from `runtime/chat.py:296`, `runtime/agent.py`), `oneshot()` :79, `interrupt()` :83, `health()` :91. The worker publishes the status to Redis (`publish_status` :105, from `main_worker.py:54`); the app reads it (`read_status` :121), because the app is not on `claude_int`. `claude_code_check.py` is a manual CLI check (0% covered).

### A.2 Compose / deployment notes
- `docker-compose.yml`: networks `core`, internal `sandbox_int`, `sandbox_net_int`, `mcp_int`, `browser_int`, `claude_int`, plus non-internal `egress`. Only `app` publishes a port (`${APP_BIND:-0.0.0.0}:${APP_PORT:-8080}`). The app is also on `browser_int` for the Browser panel. Sandboxes: read_only, cap_drop ALL, no-new-privileges, pids 512, memory/CPU from env, tmpfs /tmp. Valkey has persistence off.
- `docker-compose.dev.yml`: rebuilds with `INSTALL_DEV`, mounts `./backend`, mounts execd/hostd/browserd **source** into the app at `/opt/{execd,hostd,browserd}-src` so the backend tests run the real daemons in-process. It exposes Postgres and Valkey on 127.0.0.1, adds a Vite `frontend` service, and sets `API_PROXY_TARGET`.
- `deploy/zimaos/docker-compose.yml`: prebuilt `ghcr.io/essntl/anemo*:latest` images. All settings are inline (`x-settings`); a busybox `init` service chowns the volumes to **hard-coded 1000:1000** (ignores PUID). `claude-runner`, `browser` and `mcp-host` are always on (no profiles). The secret key, admin password and DB password are all CHANGE_ME (see S5). It has an `x-casaos` block.
- Dockerfiles: backend is a 3-stage build (node frontend → uv deps → slim runtime; copies all of `backend/` **including `tests/`** into the image; APP_COMMIT/APP_INSTALL build args go last). The sandbox/mcp-host/browser images pin deps with `>=` ranges (`fastapi>=0.115`, `uvicorn>=0.32`, `mcp>=2.2,<3`; `uv:0.9` and `node` are floating), so builds can't be reproduced. claude-runner pins everything exactly. The browser image pins `playwright==1.63.0`.
- `.github/workflows/ci.yml`: backend (ruff, format, mypy, pytest, `alembic check`) inside the dev compose; frontend (typecheck, lint, vitest, build); browser-service (builds the browser image, runs `browser/tests/run.sh`); claude-runner (builds, runs `tests/run.sh` with the real CLI against the fake API); e2e (`needs: backend, frontend`, runs `e2e/run-isolated.sh`). **No CI job builds the sandbox or mcp-host images**; their source is only tested in-process by the backend tests. Actions are pinned to major tags, not SHAs.
- `images.yml`: a matrix of 5 images, linux/amd64, pushed to GHCR (`latest` on main, `sha-<short>`, semver; the runner also gets `claude-code-<ver>`). **It pushes before it runs the runner image test** (:182-204), so a failing test still leaves a published `latest`.
- `Makefile`: `up` (sets APP_COMMIT), `dev`, `test-backend`, `test-frontend`, `e2e`, `lint`, `fmt`, `migrate`, `revision`, `gen-api`, `backup`.
- `scripts/backup.sh`: `pg_dump --format=custom`, plus tar of `/data` and `/workspace` taken from the `app` container, plus a VERSION file; fails if any part is empty. `scripts/restore.sh`: asks to confirm (`RESTORE_YES=1` skips), stops app and worker, `pg_restore --clean --if-exists`, untars with `compose run --entrypoint tar app`, then `up -d`. See bug B2.

### A.3 Environment variables

**Read by the backend** (`backend/app/core/config.py`, pydantic-settings, case-insensitive): `ENV`, `LOG_LEVEL`, `DATABASE_URL`, `REDIS_URL`, `APP_SECRET_KEY` (≥32 characters unless ENV=test), `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, `ADMIN_PASSWORD`, `PUBLIC_URL`, `COOKIE_SECURE`, `SESSION_DAYS`, `TRUSTED_PROXIES` (**defined but never read**), `TZ`, `WORKSPACE_PATH` (inside the container, default `/workspace`), `DATA_PATH`, `STATIC_DIR`, `APP_COMMIT`, `APP_INSTALL`, `UPDATE_CHECK`, `UPDATE_REPO`, `WORKER_CONCURRENCY`, `ENABLE_FAKE_PROVIDER`, `SEARXNG_URL`, `SANDBOX_URL`, `SANDBOX_NET_URL`, `SANDBOX_TOKEN_FILE`, `SANDBOX_NET_TOKEN_FILE`, `SANDBOX_SSH_DIR`, `MCP_HOST_URL`, `MCP_HOST_TOKEN_FILE`, `BROWSER_URL`, `BROWSER_TOKEN_FILE`, `CLAUDE_RUNNER_URL`, `CLAUDE_RUNNER_TOKEN_FILE`. Uvicorn reads `FORWARDED_ALLOW_IPS`.

**Read by the side services**: execd `EXECD_WORKSPACE`, `EXECD_TOKEN_FILE`, `EXECD_MAX_OUTPUT_BYTES`, `EXECD_TOKEN`, `EXECD_SSH`, `HOME`. hostd `HOSTD_TOKEN_FILE`, `HOSTD_START_TIMEOUT_S`, `HOSTD_IDLE_STOP_S`, `HOSTD_TOKEN`. browserd `BROWSERD_TOKEN_FILE`, `BROWSERD_IDLE_CLOSE_S`, `BROWSERD_MAX_SESSIONS`, `BROWSERD_TOKEN`, `PLAYWRIGHT_BROWSERS_PATH` (Dockerfile). runner `LOG_LEVEL`, `RUNNER_TOKEN_FILE`, `RUNNER_MAX_PROCESSES`, `RUNNER_LOCK_WAIT_S`, `RUNNER_TOKEN`, `RUNNER_CWD`, `RUNNER_CLI_PATH`, `RUNNER_IDLE_S`, `RUNNER_TMP`, `CLAUDE_CONFIG_DIR`, `CLAUDE_REAL_CLI`, `HOME`, `DISABLE_AUTOUPDATER`, plus the CLI env it sets itself (`launch.py:60-84`). Tests: `CLAUDE_TEST_CLI`.

**Compose-only (interpolation)**: `APP_VERSION`, `PUID`, `PGID`, `APP_COMMIT`, `APP_BIND`, `APP_PORT`, `WORKSPACE_PATH` (host path!), `SANDBOX_MEMORY`, `SANDBOX_CPUS`, `MCP_HOST_MEMORY`, `MCP_HOST_CPUS`, `BROWSER_MEMORY`, `BROWSER_CPUS`, `CLAUDE_RUNNER_IMAGE`, `CLAUDE_RUNNER_MEMORY`, `CLAUDE_RUNNER_CPUS`, `CLAUDE_RUNNER_IDLE_S` (→ `RUNNER_IDLE_S`), `CLAUDE_RUNNER_MAX_PROCESSES` (→ `RUNNER_MAX_PROCESSES`), `INSTALL_DEV`, `API_PROXY_TARGET`, `COMPOSE_PROFILES` (docker), `POSTGRES_USER/DB/PASSWORD`. e2e: `E2E_BASE_URL`, `E2E_USERNAME`, `E2E_PASSWORD`, `E2E_PORT`, `E2E_BROWSER`, `KEEP`. Scripts: `COMPOSE`, `RESTORE_YES`.

**Mismatches**
- Used in compose but missing from `.env.example` and the docs: `MCP_HOST_MEMORY`, `MCP_HOST_CPUS`, `BROWSER_MEMORY`, `BROWSER_CPUS`, `APP_VERSION`, `ENV`, `APP_COMMIT` (README mentions it, `.env.example` doesn't), `ENABLE_FAKE_PROVIDER` (README only).
- Backend settings that **cannot be set** in either compose file, because they are not passed into the container's environment: `SESSION_DAYS` (docs/security.md says sessions last 30 days), `DATA_PATH`, the `*_URL` / `*_TOKEN_FILE` overrides. That is fine for the internal ones; worth knowing for SESSION_DAYS.
- `TRUSTED_PROXIES` is passed and documented, but the code never reads it. Only `FORWARDED_ALLOW_IPS` (copied from it) has an effect. The ZimaOS file sets both separately and could let them drift. The comment in `api/deps.py:54` is misleading.
- `WORKSPACE_PATH` means two things: the host path in `.env`/compose, and the in-container path in `Settings.workspace_path`. Compose never passes it through, so this works today; an `env_file: .env` would break it.
- ZimaOS lacks `ADMIN_PASSWORD_HASH` (it forces the plaintext password), `UPDATE_CHECK`/`UPDATE_REPO`, PUID/PGID (hard-coded 1000), and resource variables (hard-coded).
- Docs out of sync with the code: `docs/architecture.md:554` says `.env.example` holds `SANDBOX_TOKEN`/`BROWSER_TOKEN`/`MCP_HOST_TOKEN` (they don't exist; token files are generated per start). It lists a `valkey-data` volume (doesn't exist), promises **ntfy** destinations (`:227,469,694`; only `discord` and `webpush` exist, `notifications/schemas.py:47`), says Web Push is "deferred" (it is implemented), and makes the `O_NOFOLLOW` claim (S4). The "only the worker can reach it" claims are covered under S2. `e2e/run-isolated.sh:3-4` says "no test is skipped", but `browser.spec.ts:16` skips unless `E2E_BROWSER=1`, and `automations.spec.ts:81` skips when a Discord destination receives reminders.

### A.4 Duplicated code between the services (refactor candidates)
1. **Token bootstrap**: `_token = os.environ.get("<X>_TOKEN") or secrets.token_urlsafe(32)` plus an identical `_write_token()` in execd :42-54, hostd :44-55, browserd :58-69, runner :50-63. Only the env names differ.
2. **`_check_auth`** in two variants: prefix-strip (execd :103, runner :91) and exact header (hostd :165, browserd :189). They behave differently: execd and runner also accept a bare token with no `Bearer`.
3. **`/health`** shapes differ: `{"status":"ok"}` / `+servers` / `+sessions` / `{"ok":True,...}`. All are unauthenticated.
4. **App construction**: `FastAPI(title=..., docs_url=None, redoc_url=None, openapi_url=None, lifespan=...)` four times. The lifespan writes the token, and some clean up.
5. **Idle eviction**: lazy in hostd (`_client_for`) and browserd (`_close_idle` in `session()`), a background task in the runner (`_evict_idle`).
6. **NDJSON `_line()`** helper in execd :161 and runner :158.
7. **`_describe(exc)`** (unwrap an ExceptionGroup) in hostd :86 and backend `mcp/client.py:69`.
8. **SSRF rules**: `browser/browserd/guard.py` (Allowlist, parse_allowlist, is_public, checked_address) and `backend/app/web/safe_http.py:36-114` hold the same logic, kept separate on purpose because the browser image is stdlib-only. One difference: the backend's `parse_allowlist` raises on bad entries, the guard ignores them. `tests/unit/test_browser_guard.py` imports the guard from the mounted source.
9. **Logging**: only the runner configures logging (`basicConfig`, plain format, `LOG_LEVEL`). The others rely on uvicorn defaults with access logs off. The backend has its own `core/logging.py`. Nothing is shared.
10. **Dockerfiles**: the same skeleton four times (python:3.13-slim, venv, PUID/PGID user, tini, uvicorn CMD) and the same compose healthcheck (`python -c urllib.request.urlopen(.../health)`).
11. **Backend clients**: the same `override`-hook / read-token-file / `(url, token, transport)` `_connection()` in `sandbox_client.py:37-55`, `browser_client.py:28-48`, `claude_runner_client.py:31-52` and `mcp/client.py:155-171`. Each also repeats the same 401 → "rejected the access token; restart it" mapping.

---

## B. Test coverage map

### B.1 Backend tests (`backend/tests`, pytest, 783 tests; [n] = number of test functions)
Helpers: `conftest.py` (test settings, DB/Redis fixtures, authed client), `fake_claude_runner.py` (stand-in for runner + CLI), `mcp_server.py` (real MCP servers over HTTP/SSE/stdio built with the SDK), `office_files.py` (in-memory docx/xlsx/pptx/zip), `web_server.py` (local HTTP server for web tools).

**unit/**
- `test_anthropic_cache.py` [3] Anthropic adapter: where the prompt-cache breakpoints go.
- `test_browser_guard.py` [4] browserd guard proxy: blocking and allowlist (runs the real guard.py source).
- `test_citations.py` [3] Citations become numbered links with a source list.
- `test_claude_code_adapter.py` [16] Claude Code adapter delta logic: what is sent per turn, session reuse.
- `test_crypto.py` [3] Fernet round trip, randomized ciphertext, wrong key fails clearly.
- `test_document_links.py` [2] Markdown links to documents with fragments.
- `test_extract.py` [9] Text extraction from Office files and zips (limits, DTD refusal).
- `test_fs_guard.py` [4] Paths inside, escapes, symlink escape, relative().
- `test_ids.py` [3] uuid7 properties.
- `test_images.py` [6] Image downscaling, conversion, garbage rejection, token cost.
- `test_mcp_unit.py` [5] MCP names, schemas, results, risk.
- `test_policy_engine.py` [14] Permission engine, table-driven plus property-based (hypothesis).
- `test_providers_unit.py` [6] Capability guesses, routing, OpenAI/Anthropic conversion, cost.
- `test_recurrence.py` [6] RRULE/DST handling for events.
- `test_schedule.py` [6] Automation schedule validation and next run.
- `test_security.py` [2] Origin rules, recent-auth window.
- `test_shell_risk.py` [4] Shell-command risk-rating corpus.
- `test_web.py` [8] SSRF guard, page extraction, SearXNG parsing.
- `test_webpush.py` [10] RFC 8291 encryption against the RFC vectors, VAPID JWT.

**api/** (ASGI client against real Postgres/Valkey; runs execute in-process)
- `test_agent.py` [15] Agent runs end to end with a scripted model: tool requests, permission checks, approvals.
- `test_agent_files.py` [10] File tools: recorded changes, revert, per-folder access.
- `test_agent_runtime.py` [13] Pause/resume, plan review, limits, compaction, long runs.
- `test_attachments.py` [6] Upload kinds and rejections, text/PDF to the model, vision gating, download vs inline, file-only messages.
- `test_auth.py` [9] Login cookie flags, bad credentials, rate limit, logout, forged cookie, **every non-public route needs a session**, cross-origin POST blocked, reauth, audit.
- `test_browser.py` [9] Browser tools and panel API against a stand-in browserd.
- `test_capabilities.py` [5] Model capabilities assumed, then learned.
- `test_chat.py` [13] Chat turns end to end (streaming events, cancel, retries).
- `test_claude_code_runtime.py` [3] Agent runs on the claude_code provider through the fake runner.
- `test_daily_notes.py` [6] Daily notes stored as `documents/daily/<date>.md`.
- `test_diagrams.py` [3] Diagram/chart/math prompt guidance and `/diagram`.
- `test_documents.py` [10] Documents: index, revisions, conflicts, agent tools.
- `test_failures.py` [8] Worker death mid-run, Redis down, secrets never leaked (saves a key, then searches everything for it).
- `test_file_exchange.py` [7] Office files/zips as attachments, outputs, unzip safety.
- `test_files.py` [7] File manager list/read, save conflicts, upload/folder/move names, copy, trash/restore, traversal rejected, downloads never render active content.
- `test_focus.py` [4] Focus sessions and notifications.
- `test_focus_tools.py` [4] Focus/music agent tools (incl. `queue_music` with `replace=True`), open-tab check.
- `test_health.py` [2] /health without dependencies; unknown API route gives a JSON 404.
- `test_links.py` [4] Links between files, documents and tasks.
- `test_mcp.py` [10] MCP servers (http/sse/stdio through an in-process hostd), discovery, tool changes go to "ask".
- `test_memory.py` [9] Memory API, retrieval, memory tools, secret filtering.
- `test_music.py` [3] Track library dedupe/metadata; playlists (**POST append skips duplicates, PUT replaces/reorders**); needs a session.
- `test_notifications_automations.py` [20] Notification list/prune, **Discord** destinations (secret kept, test button, delivery, retries, kinds), agent notify, automations CRUD, scheduled runs, due/late, once, run-now, approvals during automations, retries, result saved as a document.
- `test_profiles_skills.py` [5] Profiles and skills rules and their effect on runs.
- `test_projects_chats.py` [14] Projects, organising chats, references, edit/branch/export.
- `test_providers.py` [5] Key encrypted and never returned, recent-auth needed, discover/import/test, routing, delete.
- `test_push.py` [16] **Web Push**: VAPID key, subscribe/rename/renew, validation, recent auth, outbox delivery, gone devices, retry, allow/deny from the notification, expiry, miss rate limit.
- `test_search_usage.py` [6] Workspace search and the usage summary.
- `test_settings.py` [4] Defaults, appearance, validation, focus/home/files sections.
- `test_setup_updates.py` [13] First-run setup state and the update notice (GitHub compare stubbed).
- `test_shares.py` [10] Share links: frozen copies, relinking, expiry, revoke, misses.
- `test_shell.py` [15] `run_shell`: permission checks, then real commands through a real execd (in-process from the mounted source).
- `test_slash_skills.py` [8] Skills as slash commands.
- `test_sse_connections.py` [1] Open SSE streams hold no DB connection.
- `test_stable_prefix.py` [3] Prompt prefix stays stable between runs.
- `test_stats.py` [2] Stats per local day, across DST.
- `test_subagents.py` [9] Sub-agent runs.
- `test_system.py` [3] Settings > Advanced status and gzip behaviour.
- `test_task_structure.py` [11] Checklists, subtasks, blocked-by (API, search, tools).
- `test_tasks_calendar.py` [9] Tasks, projects, calendar (repeating), reminders, tools.
- `test_temporary_chats.py` [4] Temporary chat expiry and keeping.
- `test_web.py` [6] Web tools in runs, Web & Search settings.

**integration/** — `test_queue.py` [4] Job queue: exclusive lane-scoped claim, retry backoff, lease reaping/heartbeat, dedupe key.

### B.2 Frontend unit tests (vitest + jsdom, 43 files / 197 tests)
`app/useSidebarSwipe` (swipe detection), `components/diagrams/Markdown.test.tsx` + `diagrams.test.ts` (charts, mermaid, math, fence detection), `components/ui/{Lingering,controls,dialogs,toast}` (UI primitives), `features/agents/components/{PlanEditor,ShellCall}` (plan editing, live shell output), `automations/scheduleForm` (schedule editor), `browser/input` (click scaling, keys), `chat/{age,pastedFiles,questionMarks,remaining,runStream}` (**runStream = SSE run reducer: text/reasoning accumulation, restart**), `documents/{passage,roundtrip,useAutosave}` (fragment links, Markdown round trip, autosave + conflict), `focus/timer` (timer maths, reload survival), `home/{dailyNote,layout}`, `island/alerts`, `mcp/lines` (header/env parsing), `music/player/controller` (**append when idle, replace via playTracks, repeat, skip, undo**), `music/player/detect` (YouTube/SoundCloud detection), `notifications/{push,sw}` (device names, service worker push and approval buttons), `search/search.test.tsx` (pages, snippets), `settings/theme`, `setup/steps`, `shares/links`, `shortcuts/{guard,registry}`, `skills/slash`, `stats/ranges`, `tasks/{dates,relations,repeat}`, `hooks/useShiftHeld`, `lib/{appLinks,citations,format}`.
Not tested on the frontend: login form, API client/CSRF handling, `chat/agentControl.ts` (`onMusicControl` / `onFocusControl` dispatch), Settings pages, Providers UI, Files UI, Projects, the shares page renderer.

### B.3 E2E (Playwright, `e2e/tests/*.spec.ts`)
Projects (`playwright.config.ts`): `desktop` (Desktop Chrome, all specs except mobile/automations), `mobile` (Pixel 7 touch, `mobile.spec.ts`), `notifications` (`automations.spec.ts`, runs after the other two). Serial, no retries, trace kept on failure. `helpers.ts`: `login`, `fakeModels` (finds the echo/slow/agent model ids), `newChat`, `pickModel`, `answerPrompt`, `send`, `signOutAfterEach`, `recordAnimations`, `startMusic`/`removeTrack`.
- `agents.spec.ts` — create an agent profile and pick it in chat; import/disable/export/delete a skill; runs page filters and limits settings; SearXNG test reports unreachable without saving; memory page add/edit/archive/delete.
- `attachments.spec.ts` — attach a PDF to a task, open it, rename it in Files.
- `automations.spec.ts` — automation create/schedule/off/edit/delete; a reminder arrives as a notification and opens its target (skipped if a Discord destination gets reminders); notification settings: desktop notifications and the Discord dialog.
- `browser.spec.ts` — Browser panel open/use/pop out/close (**skipped unless the browser container runs**, i.e. `E2E_BROWSER=1`).
- `chat.spec.ts` — login required; sign out closes the app; **streaming reply survives a reload mid-stream**; stop keeps partial text; attached text file reaches the model; agent asks a question (suggested or typed answer); **agent approval (fs.read set to ask → Allow once → finishes)**; file manager create/edit/save/trash/restore.
- `cursor.spec.ts` — every clickable element shows a pointer cursor.
- `daily-note.spec.ts` — daily notes add/tick/edit/move/delete, previous day.
- `diagrams.spec.ts` — an answer and a document draw mermaid/chart/math.
- `document-links.spec.ts` — a link to a document by file opens at the quoted passage.
- `documents.spec.ts` — write, autosave, outside change, history, delete.
- `files.spec.ts` — cut/copy/paste in Files; files and documents into a project.
- `focus.spec.ts` — focus session for a task; the timer survives navigation and reload; start/pause from search, edit Home.
- `home.spec.ts` — rearrange/resize widgets (saved); Today adds/completes a task; Ask Anemo starts a chat.
- `island.spec.ts` — play/pause music from the Island; the Island shows the timer.
- `mcp.spec.ts` — add an MCP server, see why it fails, edit, remove (no working server).
- `mobile.spec.ts` — no sideways scroll; drawer; swipe; model capability tags; dropdowns fit; sign out; settings list; files full screen; calendar on a phone; chat send button / Enter adds a newline; PWA manifest, icons, a service worker that never caches /api; Island; Home in one column; no shortcut sheet on touch.
- `motion.spec.ts` — close animations, page cross-fade.
- `music.spec.ts` — invalid link error; add track (empty queue → plays), pause; saved to library; save queue as playlist; Space toggles.
- `paste.spec.ts` — paste a screenshot or file and send it with no text.
- `planner.spec.ts` — tasks quick add/due/complete/board; task notes as Markdown; task ↔ document links; calendar add/see/open/delete.
- `projects.spec.ts` — all-chats overview filter/sort/bulk; pinned pages layout; projects narrow the chat list; reference a chat, edit the last message, branch, save as document.
- `providers.spec.ts` — correct a model's capabilities by hand.
- `push.spec.ts` — push settings card, device listed and removed; public approval endpoint needs its token and nothing else works.
- `search.spec.ts` — Ctrl+K finds a task and a page, results filter by kind; usage page totals/breakdown/periods.
- `setup.spec.ts` — first-run setup walks through its steps, resumes, finishes; Advanced says when a build can't be compared for updates.
- `shares.spec.ts` — share a chat, read it logged out, revoke; the shared chat changes only when the copy is updated; shared document and project.
- `shortcuts.spec.ts` — `?` sheet, typing `?`, search box/settings open the sheet.
- `subtasks.spec.ts` — checklist, subtask, blocked-by; the board asks before finishing a task with open subtasks.
- `temporary.spec.ts` — temporary chat countdown and keep; on touch, a tap opens the explanation.

### B.4 Side-service tests
- `browser/tests/test_browserd.py` (runs inside the browser image with real Chromium, via `browser/tests/run.sh`): needs the token; open describes the page; click/type/select; new tabs continue in the session; bot checks recognised; scrolling/long pages; **private addresses blocked unless allowed**; sessions separate and closable; user view/input; live stream; user-started session and scroll.
- `claude-runner/tests` (inside the runner image with the **real pinned CLI** against `fake_api.py`, a scripted Messages API that records requests and fakes cache usage; `conftest.py` starts runnerd with decoy secret env vars): `test_units.py` (env allowlist, forbidden prefixes win, fixed launch options, usage-limit classification, gone-call messages); `test_cli_integration.py` (only Anemo tools and a clean env reach the API; parked tool calls; eviction with a parked call sends nothing and resume delivers it; runner restart resumes; system prompt recorded; tool-list change restarts with resume; fork keeps the prefix; health reports only three facts; oneshot has no tools or session).

### B.5 How e2e runs (`e2e/run-isolated.sh`, `e2e/scripts`)
1. Builds `e2e/.tmp/env` with random `APP_SECRET_KEY`, `POSTGRES_PASSWORD` and `ADMIN_PASSWORD` (via `od /dev/urandom`), `APP_VERSION=e2e`, `WORKSPACE_PATH=./e2e/.tmp/workspace`, `APP_PORT=8090` (`E2E_PORT`), `PUBLIC_URL`, `COOKIE_SECURE=false`, **`ENABLE_FAKE_PROVIDER=true`**, and PUID/PGID = the current user on Linux.
2. `docker compose -p anemo-e2e --env-file e2e/.tmp/env [--profile browser] up -d --build --wait`: a full throwaway stack (own project name, so its own volumes and networks). Note: it binds `0.0.0.0:8090` because `APP_BIND` is not overridden.
3. `node e2e/scripts/seed-fake.mjs`: logs in through the API (sends an `Origin` header to pass the CSRF check), creates a provider of type `fake`, imports models `echo`, `slow` and `agent`, sets `echo` as the default chat model, logs out.
4. `npx playwright test` with `E2E_BASE_URL`/`E2E_PASSWORD`.
5. A trap runs `compose down -v --remove-orphans` and `rm -rf e2e/.tmp` (unless `KEEP=1`).
- The scripted model: `backend/app/providers/adapters/fake.py`, enabled by `ENABLE_FAKE_PROVIDER` or `ENV=test` (`providers/registry.py:62`). `echo` streams "You said: …" word by word; `slow` streams slowly (for cancel/reconnect); `agent` plans, lists the workspace (an `fs.read` tool call, hence the approval test), and "ask me" makes it ask a question; `reasoning`; `no-tools`; `scripted` replays `FakeAdapter.scripts` (backend tests only). It also answers compaction and memory-extraction prompts.
- `e2e/scripts/make-icons.cjs` renders the PWA icons from one SVG with Playwright Chromium. It is not part of the test run.

### B.6 Coverage of the critical flows (API = backend api/unit tests, FE = vitest, E2E = Playwright)
| Flow | API | FE | E2E | Gaps |
|---|---|---|---|---|
| Login / session | test_auth, unit/test_security | — | chat.spec (login required, sign out), mobile (sign out); every spec logs in | no FE login test; cookie max-age vs sliding expiry untested (B8) |
| Chat with streaming | test_chat, test_sse_connections, test_failures, test_stable_prefix | chat/runStream | chat.spec (stream + reload, stop), mobile chat | — |
| Tool call + approval | test_agent, test_agent_runtime, test_push (approve via push), unit/test_policy_engine, test_notifications_automations (approvals in automations) | ShellCall, PlanEditor, notifications/sw (approval buttons) | chat.spec (approval), push.spec (public action endpoint) | "Deny" / "always allow" not in E2E |
| Documents CRUD | test_documents, test_links, unit/test_document_links | documents/roundtrip, useAutosave, passage | documents.spec, document-links.spec, diagrams.spec, planner (links) | create with `folder` traversal untested (S6) |
| Tasks | test_tasks_calendar, test_task_structure, test_links | tasks/dates, relations, repeat | planner.spec, subtasks.spec, home.spec (Today), search.spec | — |
| Calendar | test_tasks_calendar, unit/test_recurrence | — | planner.spec (calendar), mobile (calendar) | no FE calendar unit tests |
| Focus timer | test_focus, test_focus_tools | focus/timer | focus.spec, island.spec | — |
| Music queue (append vs replace) | test_music (playlist POST append vs PUT replace), test_focus_tools (`queue_music` replace flag in the event) | music/controller (append when idle, playTracks replace) | music.spec (add to empty queue, save playlist), island.spec, mobile Island | **No test of appending to a non-empty/playing queue (index kept, no restart); no test of `agentControl.onMusicControl` mapping `replace` → `playTracks` vs `append`; no E2E of "Play playlist" replacing the queue.** |
| Memories | test_memory | — | agents.spec (memory page) | — |
| Notifications: Discord | test_notifications_automations | — | automations.spec (Discord dialog only) | — |
| Notifications: ntfy | — | — | — | **not implemented** (documented only) |
| Notifications: Web Push | test_push, unit/test_webpush | notifications/push, sw | push.spec | real push service delivery not E2E (expected) |
| Automations / scheduled | test_notifications_automations, unit/test_schedule, integration/test_queue | automations/scheduleForm | automations.spec | worker scheduler loop `jobs/scheduler.py` and `jobs/runner.py` at 0% (runs execute in-process in tests) |
| MCP | test_mcp (real servers, in-process hostd), unit/test_mcp_unit | mcp/lines | mcp.spec (failing server only) | no E2E with a working MCP server; mcp-host image never built in CI; `features/mcp/router.py` 48.6% |
| Browser | test_browser (stand-in), unit/test_browser_guard; browser/tests (real Chromium) | browser/input | browser.spec (skipped by default) | E2E normally skipped in CI |
| Shell sandbox | test_shell (real execd in-process), unit/test_shell_risk | ShellCall | — | **no E2E**; container hardening (read_only, no network) never verified by any test; sandbox image not built in CI |
| Uploads / attachments | test_attachments, test_file_exchange, test_files, unit/test_extract, unit/test_images | chat/pastedFiles | attachments.spec, paste.spec, chat.spec (text file), files.spec | — |
| Shares | test_shares | shares/links | shares.spec | — |
| Search | test_search_usage, test_task_structure | search/search | search.spec | — |
| Projects | test_projects_chats | — | projects.spec, files.spec | — |
| Skills / profiles | test_profiles_skills, test_slash_skills | skills/slash | agents.spec | — |
| Providers / models | test_providers, test_capabilities, unit/test_providers_unit, unit/test_anthropic_cache, unit/test_claude_code_adapter, test_claude_code_runtime; claude-runner/tests | — | providers.spec, mobile (adding models) | `openai_chat.py` 24%, `anthropic.py` 59% (real adapters barely exercised) |
| Settings | test_settings, test_system | settings/theme | agents.spec (limits), mobile settings | `settings/service.py` 54% |
| Setup / first run | test_setup_updates | setup/steps | setup.spec | — |
| Update notice | test_setup_updates | — | setup.spec (Advanced) | — |
| Daily notes | test_daily_notes | home/dailyNote | daily-note.spec | — |
| Links | test_links, unit/test_document_links | lib/appLinks, documents/passage | document-links.spec, planner.spec | — |
| Stats / usage | test_stats, test_search_usage | stats/ranges | search.spec (usage page) | — |

### B.7 Backend files below 60% line coverage (from `the baseline coverage report`, 238 files, total 82.8%)
| Coverage | Statements | Missed | File |
|---|---|---|---|
| 0.0% | 25 | 25 | app/jobs/scheduler.py |
| 0.0% | 41 | 41 | app/cli.py |
| 0.0% | 67 | 67 | app/main_worker.py |
| 0.0% | 99 | 99 | app/claude_code_check.py |
| 0.0% | 155 | 155 | app/jobs/runner.py |
| 24.3% | 173 | 131 | app/providers/adapters/openai_chat.py |
| 39.7% | 78 | 47 | app/claude_runner_client.py |
| 46.6% | 350 | 187 | app/features/conversations/service.py |
| 48.6% | 72 | 37 | app/features/mcp/router.py |
| 53.8% | 39 | 18 | app/features/settings/service.py |
| 58.9% | 190 | 78 | app/features/providers/service.py |
| 59.2% | 120 | 49 | app/providers/adapters/anthropic.py |
| 59.8% | 97 | 39 | app/features/conversations/router.py |
For a behaviour-preserving refactor, the riskiest of these are `conversations/service.py` and `conversations/router.py` (core chat CRUD, under half covered), `jobs/runner.py` and `main_worker.py` (the real worker loop, never run in tests), and the two real provider adapters.

---

## C. Security review (other than section 0)
- **Auth/session** (`features/auth/service.py`, `router.py`, `api/deps.py`): single user; argon2 hash or plaintext with `hmac.compare_digest`; a dummy hash on a wrong username equalises timing; tokens are 32-byte random, stored as SHA-256; cookie `aiw_session` is HttpOnly, SameSite=Lax, Secure by default; 30-day sliding expiry (DB only, see B8); reauth window 15 minutes for providers, permissions, MCP, notifications, push subscribe, some profile/settings changes. Every feature router sits under `protected` with `Depends(require_session)` (`api/router.py:57-91`); only health, auth, `public/shares/{token}` and `public/push/actions` are public, and `test_auth.py::every_non_public_route_requires_a_session` checks that. Good.
- **CSRF** (`api/security.py:24-61`): non-GET `/api/*` requests with an `Origin` or `Referer` must match the Host header or PUBLIC_URL's host. Requests with neither header are allowed (non-browser clients, relying on SameSite=Lax). Acceptable for a single-user app; `Origin: null` is rejected. No CORS middleware (good).
- **Rate limiting**: login and reauth (per IP 5/min, global 30/min, in Redis, fails open when Redis is down by design), share/push misses per IP. Nothing else (fine for single user). See S7 and S10.
- **Secret encryption** (`core/crypto.py`): Fernet with a key from HKDF-SHA256 (static salt `ai-workspace`, info `secrets-v1`) over APP_SECRET_KEY (≥32 chars enforced). Sound for a high-entropy master key. There is no key rotation (`rotate-key` is "planned"), and a changed key gives a clear DecryptionError.
- **Inter-service auth**: per-start random bearer tokens via volumes (good), with inconsistent checks (A.4 #2), unauthenticated health, and a shared egress network (S2). The execd docstring says agent commands can read their own sandbox's token: "gives nothing they can't already do". True, because each sandbox has its own token volume.
- **Container hardening**: sandboxes, mcp-host, browser and runner are well hardened. App, worker and migrate are not (S3). Valkey and Postgres have no password on Valkey; it is reachable only on `core` (app, worker, migrate, postgres; the dev overlay binds 127.0.0.1).
- **Path traversal**: `fs_guard.resolve` (resolve + `is_relative_to`, NUL and drive letters rejected, `/workspace/` prefix stripped) is used by files, documents and tools; zip unpack rejects `..`, absolute paths and symlinks and has ratio/size limits; the SPA static handler checks `is_relative_to` (`main_api.py:88-89`). Weak spots are S4 (symlink TOCTOU) and S6 (document folder mkdir).
- **SSRF**: `web/safe_http.py` checks every connection, including each redirect, at the network-backend level (rebinding-safe, SNI kept, unix sockets refused, `trust_env=False`). Web Push endpoints are https:443 only and go through the guarded client. User-configured URLs (providers, SearXNG, Discord webhooks, remote MCP) use normal clients from the worker, which sits on every internal network, but only the authenticated owner sets them. The Discord validator's error says "must start with https://" but accepts `http` (`notifications/schemas.py:37-42`). Browser guard: see A.1 and S8. Neither guard limits CONNECT ports; NAT64 `64:ff9b::/96` counts as global in Python's `is_global`, which only matters on NAT64 hosts.
- **Shares** (`features/shares`): 256-bit token, frozen snapshot (chat user/assistant text only, attachments as names; documents; project tasks/events/docs), app links rewritten, `no-store`, `noindex`, `no-referrer`, view counter, per-IP miss limit. Tokens are stored in plaintext (S11). Markdown is rendered with react-markdown without raw HTML; mermaid runs with `securityLevel: 'strict'` and `htmlLabels: false` (`frontend/src/components/diagrams/mermaidConfig.ts:40-43`) before `dangerouslySetInnerHTML` (`DiagramBlock.tsx:99`). OK.
- **Uploads** (`features/attachments`, `features/files/router.py`): attachments are capped at 25 MB (images 10 MB) and classified by magic bytes; files upload is 200 MB **per file with no count limit**, all held in memory (authenticated DoS only). Only PNG/JPEG/GIF/WebP are served inline; everything else is `application/octet-stream` + `attachment`, and `test_files.py::downloads_never_render_active_content` checks this. Filenames are reduced to their basename. No `nosniff` header (S9).
- **Committed files**: `dump.rdb` (S1). Nothing else sensitive is tracked.

---

## D. Bugs noticed in passing (not fixed)
| # | Severity | Location | What's wrong | Suggested fix |
|---|---|---|---|---|
| B1 | Low-Med | `backend/app/features/documents/service.py:396-401` | = S6: the unvalidated `folder` is mkdir'd outside the workspace, then a 500 | validate before mkdir |
| B2 | Low-Med | `scripts/restore.sh:49,75-79` (also the `backup.sh:7-10` claim) | The comment says `COMPOSE="docker compose -p <name>"` works "for an install without a compose file". Without the file, `compose run ... app` and `compose up -d` fail, because they need the service definitions, so restore breaks halfway, after the DB was already replaced. | Use `docker compose -p <name> -f <file>`, or use `docker exec`/`docker run` with the image name; check up front that the config resolves (`$COMPOSE config -q`) before stopping anything. |
| B3 | Low | `claude-runner/runnerd/app.py:66-74` vs `:222-228` | `_evict_idle` pops sessions that are not locked and idle for longer than IDLE_S. `turn()` gets the Session with `setdefault`, but `_turn_events` takes the lock and refreshes `last_used` only when streaming starts. If eviction runs in that window, the turn keeps going on a Session that is no longer in `_sessions`. Its process is then untracked: never evicted, not counted by `_make_room`. A later turn with the same key starts a second process for the same Claude session. | Set `session.last_used` in `turn()` before returning, or re-insert/verify `_sessions[key] is session` after acquiring the lock. |
| B4 | Low | `sandbox/execd/app.py:243-246` vs `:178` | The duplicate-id check (`req.id in _running`) runs before the generator registers the process, so two parallel requests with the same id both start, and the second overwrites the first's `_running` entry (DELETE then kills only one). The worker uses uuid4 ids, so this is theoretical. | Reserve the id in the handler before returning the StreamingResponse. |
| B5 | Low | `mcp-host/hostd/app.py:119-124`, `browser/browserd/app.py:110,147-151` | Idle stop/close only happens when a later request arrives, so an idle MCP server or browser context stays up indefinitely if nothing else is called. `_halt` also awaits up to 10 s while holding the global `_lock`. | Use a background reaper like the runner's `_evict_idle`; halt outside the lock. |
| B6 | Low | `browser/browserd/app.py:95` | After a Chromium crash, `_ensure_browser` runs `self.sessions.clear()` without `proxy.stop()`, so each lost session's GuardProxy server and tasks leak. | Stop each session's proxy before clearing. |
| B7 | Low | backend (`features/mcp/router.py:81` delete; conversation delete) | hostd `DELETE /servers/{id}` and runner `DELETE /sessions/{key}` are never called, so deleting an MCP server or a conversation leaves its process running until the idle timeout (30 min / 15 min). | Call them from the delete/disable paths (best-effort). |
| B8 | Low | `backend/app/features/auth/router.py:40-50` vs `service.py:125-139` | The server extends `expires_at` on activity, but the cookie's `Max-Age` is fixed at login, so the browser drops the cookie 30 days after login even when the user was active the whole time. "Sliding expiry" doesn't work end to end. | Re-issue the cookie when the session is touched (needs response access in the dependency or a middleware), or drop the cookie Max-Age and rely on the server. |
| B9 | Info | `backend/app/core/config.py:35`, `api/deps.py:54` | `trusted_proxies` is never read; the comment implies it is the mechanism. | Remove it, or use it to set uvicorn `forwarded_allow_ips` programmatically. |
| B10 | Info | `backend/app/features/notifications/schemas.py:37-42` | The error says https only but `http` is accepted. | Make the message and the check agree. |
| B11 | Info | `frontend/src/features/chat/agentControl.ts:37-39` vs `player/controller.ts:461-468` | An agent-queued URL (`queue_music` with url) is appended or replaced but **not saved to the music library**, while a user-added link is (`saveToLibrary`). Possibly intended; inconsistent. Not tested. | Decide and test (add `agentControl.test.ts`). |
| B12 | Low | `e2e/run-isolated.sh:3-4,23-35` | It claims "no test is skipped" (browser.spec skips without E2E_BROWSER=1). The throwaway stack binds `0.0.0.0:8090` with the fake provider enabled and a random plaintext password, so it is reachable on the LAN while it runs. | Add `APP_BIND=127.0.0.1` to the generated env; fix the comment. |
| B13 | Low | `.github/workflows/images.yml:182-204` | Images (including `latest`) are pushed before the runner image test runs. | Build with `load: true`, test, then push; or push `latest` only after the test. |
| B14 | Low (potential) | `claude-runner/runnerd/launch.py:139-148` | One system prompt file is written per distinct prompt digest to the 512 MB `/tmp` tmpfs and never deleted. It grows over the container's lifetime if system prompts vary (date, memory, profile). | Remove files whose sessions are gone, or keep an LRU cap. |
| B15 | Info | `claude-runner/runnerd/app.py:162-168` | `_make_room` silently lets the process count exceed `MAX_PROCESSES` when every warm process is busy. | Return a `busy` error or document it. |
| B16 | Info | `backend/app/web/safe_http.py:150-156` | `GuardedTransport.__init__` calls `super().__init__()`, which builds a default pool and SSL context, then replaces it. Wasteful, harmless. | Build the transport without the parent's pool. |
| B17 | Info | `backend/Dockerfile:34` | `COPY backend/ ./` ships `backend/tests` (fake runner, fixtures) in the production image. | Add `backend/tests` to `.dockerignore` for the runtime stage, or copy only `app/`, `migrations/`, `alembic.ini`. |
| B18 | Info | `sandbox/Dockerfile`, `mcp-host/Dockerfile`, `browser/Dockerfile` | Dependencies use `>=` ranges and floating `uv:0.9`, so builds can't be reproduced, and a FastAPI/MCP major change can break an image build on main. | Pin like claude-runner (requirements files). |
| B19 | Info | `deploy/zimaos/docker-compose.yml:88` | `chown 1000:1000` is hard-coded and ignores a custom PUID. | Document it, or parameterise. |
| B20 | Info | `docs/architecture.md` (`:227,469,518,550,554,694`) | Stale claims: ntfy, valkey-data, `*_TOKEN` in .env.example, O_NOFOLLOW, Web Push deferred. | Update the docs. |
