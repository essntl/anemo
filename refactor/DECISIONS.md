# Decisions

Internal decisions taken during the refactor, with the reason. Decisions that belong to the owner
(behaviour, API, schema, config, deployment, dependencies, deleting code) are recorded here once
the owner has made them.

## Owner decisions (2026-11-08)

| # | Question | Answer |
|---|---|---|
| O1 | Scope | Targeted refactor, not a sweep. Conventions apply to new code. |
| O2 | Branching | One `refactor/*` (or `fix/*`) branch and PR per area, off the latest `main`; notes PR first. |
| O3 | `dump.rdb` | Remove from git and ignore it, in its own PR; no history rewrite. |
| O4 | `formatSize` | One function with a decimals option; no visible change (the Files page keeps one decimal). |
| O5 | E2E | CI runs the full suite on every PR; locally, the touched flows are checked with the processes run directly. |
| O6 | Security | Fix #1 (symlink race), #4 (remote images in Markdown) and #5 (trash restore) now, each in its own PR ahead of the refactor; #6 (default permissions allow sending data out) is the owner's separate decision; the rest goes into BUGS.md. |
| O7 | Stuck runs (BUGS core-B1) | Pin in PR 2, then fix right after in a separate behaviour-change commit. |
| O8 | Pre-approved dev tooling | `pytest-cov`, `@vitest/coverage-v8`, one import-boundary checker per side. |
| O9 | Docs | No root `ARCHITECTURE.md`; update `docs/architecture.md`. Add a root `CLAUDE.md`. |

## Refactor decisions

| # | Decision | Reason |
|---|---|---|
| D1 | The audit is split into a short `AUDIT.md` and four appendices under `refactor/audit/`. | The full inventory is about 2,000 lines; the summary stays readable and the contract stays complete. |
| D2 | BUGS.md ids carry the appendix they came from (`core-B1`, `features-B4`, `frontend-3`, `services-B2`). | Each id leads back to the detailed write-up. |
| D3 | Shared run-lifecycle code goes into a new `runtime/lifecycle.py`; `agent.py` stops importing from `chat.py`. | Neither executor should depend on the other; the shared part has its own home. |
| D4 | `agent.py` is split into `agent_snapshot.py` (what a run is allowed and told at its start) and `agent_finalize.py` (ending a run and its follow-ups); the loop stays in `agent.py`. | These are the two seams with the fewest dependencies on `AgentRun` state, so they move without changes. |
| D5 | Import boundaries: `import-linter` on the backend, `dependency-cruiser` on the frontend. | `import-linter` reads Python imports directly and supports layer and "forbidden" contracts; the frontend uses oxlint, not ESLint, so a standalone checker avoids adding ESLint. |
| D6 | The API contract is one snapshot test (`backend/tests/unit/test_openapi_snapshot.py`), not a test per endpoint. CI and `make test-backend` mount `frontend/src/api/openapi.json` into the dev container and set `OPENAPI_SNAPSHOT`. | The owner asked for one snapshot test; the dev container only mounts `backend/`, and a test that silently skipped in CI would protect nothing. |
| D7 | Frontend coverage is reported as two numbers: the line percentage of files tests load, and the count of files no test loads. | Vitest's v8 provider counts untested files as empty, so the percentage alone would overstate coverage. |
| D8 | The stuck-run fix (core-B1) hooks into the job runner's final failure instead of catching every exception in the executors. | A failed attempt is still retried and can resume the run from its checkpoint, as before; only a run that would otherwise stay "running" forever is ended. |
| D9 | `runtime/lifecycle.py` holds what chat and agent runs share (driving the work until it ends or is stopped, follow-up jobs); picking a run up and counting restarts stay in each executor. | Those parts differ today (run-1, run-2); unifying them would change behaviour. |
| D10 | The prompt pieces moved with the snapshot into their own `agent_prompt.py`. | `snapshot_run` and `AgentRun` both build the system prompt; keeping it in `agent.py` would have made `agent_snapshot.py` import `agent.py` back. |
| D11 | Functions imported across modules lose their leading underscore, in a commit after the move. | The move stays byte for byte; the names then say what is meant to be used from outside. |
