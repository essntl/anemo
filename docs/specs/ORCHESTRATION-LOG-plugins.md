# Orchestration log: plugins (2026-11-25)

Whoever resumes this work continues from here. Inputs: the round's brief (plugin support:
contract first, then parallel workstreams, one PR `feat/plugins` → `main`), `CLAUDE.md`,
the docs it names, `12-plugins.md` and `CONTRACTS-plugins.md`. Every sub-agent ran on
Claude Opus in the foreground, each in its own worktree branched from `feat/plugins`;
the orchestrator merged them. Nothing was merged into `main`.

## Where things are

- Worktrees: `C:\dev\anemo\.worktrees\plugins` (`feat/plugins`, the PR branch) and the
  merged ones `plugins-runtime`, `plugins-ui`, `plugins-agent-tools`,
  `plugins-integrate`, `plugins-examples` (can be removed).
- Local checks: `C:\dev\anemo\.local-env\backend.sh <worktree> <name> …` (names used:
  f = A, g = C, i = integration, j = examples, h = orchestrator). No Docker: e2e didn't run.
- Screenshots and the local stack's scripts: `C:\dev\anemo\.local-env\tmp\plugins-shots\`
  (database `anemo_shots_plugins` left in Postgres on :55432).

## Timeline

| Step | Who | Result |
| --- | --- | --- |
| 0. Read the docs and the code (two read-only explorers: backend, frontend) | orchestrator | Facts that shaped the contract: approvals need a run; no tool call runs from HTTP; no CSP on the SPA; one origin; no git/zip/templates code; no command-palette actions API; `PageId` is a backend literal. |
| 0. Spec and contract | orchestrator | `12-plugins.md`, `CONTRACTS-plugins.md` (commits `e12bcf6`, `e528784`: the second pinned the service signatures C needed from A and made permission texts translatable). |
| 1. A: runtime and backend | sub-agent | `feat/plugins-runtime`, 8 commits: migration 0079, manifest/package/permissions/registry/calls/service/router, the frame route, the `plugin` actor, untrusted wrapping, the kill switch. 98 new tests. |
| 1. B: management UI and the host | sub-agent | `feat/plugins-ui`, 7 commits: Settings → Plugins, detail page, install and review, the card → page transition (View Transitions, `motion` fallback), the host and frame SDK, the four slots, Ctrl+K. Against hand-written types (A not merged yet). |
| 1. C: agent tools | sub-agent | `feat/plugins-agent-tools`, 4 commits: seven `plugin_*` tools, `plugins.build`, the authoring guide, the building chat. Coded against §9's signatures; two API tests could only pass after A. |
| 2. Merge A, C, B | orchestrator | Conflicts: `api/router.py` (both mounts kept), generated API files (regenerated), A's placeholder frame files (B's kept). |
| 2. Integration pass | sub-agent | `feat/plugins-integrate`, 6 commits: unique schema names, UI on generated types, permissions on contributed UI, modules in the frame bundle, guide matched to the code (with a test), an end-to-end API test, and a broken `lint-imports` contract fixed (plugin automations removed by the `automation.delete` job instead of importing the runtime). |
| 2. Example plugins | sub-agent, in parallel | `feat/plugins-examples`, 4 commits: *Word count*, *Today board*, *Weekly review* written only against the contract; 11 tests incl. a real Deno run. Its report listed where the contract was thin. |
| 2. Fixes from the examples' report | orchestrator | `init.timeZone`; `projects.list` with `tasks:read` in the page too; guide: resize snippet, templates copied as they are, scripts follow the agent permission levels; contract updated to what was built. |
| 2. Screenshots on a real local stack | sub-agent | Frame sequences of the transition (desktop, phone, dark) at 0.1× speed; two UI fixes (phone tab strip squashed, a wrong "update" badge). Judged by the orchestrator; then two more fixes: `update_pending` on the server for never-approved plugins, the document panel's tabs sized by their names. |
| 2. Docs and PR | orchestrator | features, security, roadmap, spec 12 §8 with screenshots, this log. |

## Decisions taken by the orchestrator (for Artem to confirm)

See the PR's "Decisions for you". In short: opaque-origin iframes instead of a plugin
subdomain; per-version all-or-nothing approval with the password; the plugin's own
policy (not the agent levels) for UI calls, but the agent levels for plugin scripts;
`plugins.build` defaults to "ask for dangerous" (drafts go ahead, nothing runs);
Settings → Plugins rather than a sidebar page; plugin agent tools only through MCP in v1.

## Checks at the end

- Frontend: typecheck, oxlint (one old warning), lint:imports, `npm test` 153 files / 861
  tests: all pass.
- Backend: lint (ruff, format, mypy, lint-imports) passes; every plugin test (136) passes;
  the suites of the modules touched (agent, scripts, MCP, provenance, profiles/skills,
  settings, schedules, tasks/calendar, trash, automations, capabilities, documents: 145)
  pass; `tests/unit` 730 pass, 12 fail on Windows only (`test_safe_fs`, `test_trash`).
- Not run here: the full backend suite in one go (over 30 minutes on this VM; CI runs it),
  Playwright e2e (needs Docker), a Git install against a real repository.
