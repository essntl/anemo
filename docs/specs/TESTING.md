# Testing during the fundamentals work

This machine runs Windows, and the backend only runs on Linux, so the backend checks run
in WSL (`Ubuntu-24.04`). The frontend checks run on Windows. Nothing here can reach the
live Anemo install.

## The test environment (WSL, set up once)

The setup script is `C:\Users\user\Documents\Projects\anemo-progress\bin\setup-wsl.sh`
(run as root). It installs:

- **Postgres 17.12 with pgvector 0.8.7**, from PostgreSQL's apt repository. These are
  the same major versions as production's `pgvector/pgvector:pg17`. One role,
  `anemo_test` (password `anemo_test`), may create databases and is not a superuser.
  `vector` and `pg_trgm` are pre-installed in `template1`, so every test database has
  them.
  It is a throwaway cluster, so durability is off (`fsync`, `synchronous_commit` and
  `full_page_writes`, in `conf.d/throwaway-tests.conf`): WSL stops the distro hard when
  it is idle.
- **Redis 7.0** (Valkey-compatible).
- **uv** and Python 3.13, used by the non-root user `anemo` that runs the tests.
- The sidecar sources that some tests load in-process are linked, as
  `docker-compose.dev.yml` mounts them: `/opt/execd-src`, `/opt/hostd-src` and
  `/opt/browserd-src` point into the integration checkout. The packages don't change
  them.

## Commands

`anemo-progress\bin\anemo-test.sh <id> <command>` runs everything against that checkout's
own database and Redis database:

| id | Checkout | Test database | Redis database |
|---|---|---|---|
| a1, a2, t, b1, a3, b2 | `..\anemo-<id>` | `anemo_test_<id>` | 1, 2, 3, 4, 5, 6 |
| int | the integration checkout | `anemo_test_int` | 7 |

Run it from PowerShell. From Git Bash, prefix `MSYS_NO_PATHCONV=1`.

```powershell
wsl -d Ubuntu-24.04 -u anemo -- bash /mnt/c/Users/user/Documents/Projects/anemo-progress/bin/anemo-test.sh a1 all -q
```

| Command | What it does |
|---|---|
| `all [pytest args]` | Everything the CI backend job runs: `ruff check`, `ruff format --check`, `mypy app`, `lint-imports`, migrations from zero, `alembic check`, then the whole pytest suite |
| `check` | Only the lint, type, import and migration checks |
| `pytest [args]` | Only the tests, e.g. `pytest -q tests/api/test_documents.py` |
| `gen-api` | The backend half of `make gen-api` (writes `frontend/src/api/openapi.json`); then run `npm run gen-api` in `frontend/` on Windows |

The virtual environment for each checkout lives on the Linux side, in
`~/venvs/anemo-<id>`.

**Frontend** (Windows, in the checkout's `frontend/`): run `npm ci` once, then
`npm run typecheck`, `npm run lint`, `npm run lint:imports` and `npm test`.

**E2E** (Playwright) needs the Docker stack and doesn't run here. Specs can be checked
for syntax with `cd e2e; npm ci; npx playwright test --list`. CI runs them once the work
reaches a pull request.

The orchestrator keeps the distro running with a background
`wsl -d Ubuntu-24.04 -u root -- sleep infinity`. If the distro was stopped anyway, the
runner waits up to 30 s for Postgres.

## Baseline

On `integrate/fundamentals` after wave 0 (3142f4f), `all` is green: lint, types,
imports, migrations from zero and `alembic check` pass, and 1046 tests pass with none
skipped, in about 3.5 minutes.
