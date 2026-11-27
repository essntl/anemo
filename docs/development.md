# Development

How to work on Anemo itself. The conventions for new code, and recipes for a tool, an
endpoint, a job, a setting or a page, are in [CLAUDE.md](../CLAUDE.md); the design and the
reasons behind it in [architecture.md](architecture.md).

Requires Docker and Node 22. On Windows, a WSL2 checkout is strongly recommended
(the Makefile needs `make`, which Git Bash does not include).

```bash
make dev            # hot reload; UI at http://localhost:5173
make test           # backend (in container) + frontend checks
make lint
make revision m="describe change"   # new Alembic migration
make gen-api        # regenerate frontend API types after backend changes
```

Backend tests run in parallel ([pytest-xdist](https://pytest-xdist.readthedocs.io)):
`make test-backend` and CI pass `-n auto`, one process per CPU. Each process ("worker",
`gw0`, `gw1`, …) has its own test database (`aiw_test_gw0`, …) and its own Redis database
(15, 14, …; with `TEST_REDIS_URL`, that database + 0, + 1, …), so tests never share data;
see `backend/tests/conftest.py`. Tests run in no fixed order across workers, so a test must
not depend on what another one left behind (each starts from `db_clean`).

```bash
make test-backend n=4      # 4 workers
make test-backend n=0      # one process, in file order (plain `pytest` does the same)
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

The specs run in 4 Playwright workers (`E2E_WORKERS` to change it), all against the same
single-user app, so a test must not change what other tests rely on. Keep a change private
(`newAgentChatWithLevels` gives one chat its own permission levels instead of changing
Settings) or, for what exists once (the focus timer, the Home layout), take its lock
(`useStoppedTimer`, `useHomeLayout`; `e2e/tests/appLock.ts`). A test that checks the Island
calls `ignoreAppEvents` first, so other tests' agent alerts don't show up in it. Look things
up by name, not with `.first()` on a shared list.

You can also point the tests at a running install
(`cd e2e && E2E_PASSWORD=<password> npx playwright test`). Tests that need a model
only run if the fake provider (`ENABLE_FAKE_PROVIDER=true`) is added there, and skip
themselves otherwise; they never fall back to a real model.

The `mobile` project repeats the key flows on a phone-sized touch screen
(`npx playwright test --project mobile`). App icons are generated from the Anemo mark
(`e2e/scripts/icon-shapes.cjs`): `make-icons.cjs` for the web app, `make-native-icons.cjs`
for Anemo Desktop's .ico files and Anemo Voice's launcher and notification icons
(`cd e2e && npm ci && node scripts/make-native-icons.cjs`; it uses Edge when Playwright's
Chromium isn't installed).

How a chat turn flows: the API stores the message and queues a job → the worker
streams the model's answer into a Redis stream → the browser follows it over SSE
(`/api/runs/{id}/events`) and can reconnect at any time. Stopping a run cancels
it inside the worker. See `docs/architecture.md` sections F, K and L.

Frontend: React + TypeScript + Vite + Tailwind v4. Colors are semantic tokens
(`bg-surface`, `text-muted`, `bg-accent`) defined in
`frontend/src/styles/tokens.css`; never use raw colors in components.
