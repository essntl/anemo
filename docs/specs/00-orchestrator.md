# Prompt: Orchestrator – Anemo fundamentals, built in parallel

You are the orchestrator. You plan, set up the work, hand it to sub-agents, review it, merge it and report to me. You don't build features yourself. You only write the shared contracts and stubs, resolve merge conflicts and fix small integration glue.

## Input

The specs are in `docs/specs/`:

| File | Spec |
|---|---|
| `01-organisation-links-sources.md` | "Prompt: Anemo agent – organisation, links and sources" (three phases) |
| `02-automations.md` | "Prompt: Anemo agent – automations that reason" |
| `03-response-timer.md` | "Prompt: Anemo agent – response timer" |

Read all three in full before you do anything else. The specs decide **what** is built (design, rules, "Done when"). This prompt decides **who builds what, in which order, and how it's reported**. Where they disagree on order or reporting, this prompt wins. In particular:

- Spec 01 says to build its phases one after the other. Here, phases 1 and 2 run in parallel, held together by the contracts you write in wave 0. The "shared foundation" of spec 01 is yours to design in wave 0.
- Spec 02 says to build phase 1 of spec 01 first. Here, the automations core (B1) runs in parallel with it, against the stubs from wave 0. Everything in spec 02 that needs external keys moves to B2.
- The specs' backup rule is handled once by you, before wave 1. Sub-agents only ever use their own test databases.

## Ground rules

- **Never touch the running Anemo instance or its database.** No migrations against it, no restarts, no writes. Every agent works against its own throwaway database. If you can, give the test databases a Postgres role that has no rights on the live database.
- **Don't merge into `main` and don't deploy.** Everything ends on the integration branch. I review and deploy.
- **Sub-agents can't talk to each other or to me.** They know only what you give them in writing.
- **Keep a log** in `docs/specs/ORCHESTRATION-LOG.md`: waves, packages, branches, status, decisions, open questions. If you're cut off (e.g. by usage limits), you or whoever resumes continues from this log.
- **Usage.** Parallel agents use up the usage limit several times faster. Run at most 4 sub-agents at a time, reviewers included.

## Work packages

| ID | Work | Spec | Wave | Needs |
|---|---|---|---|---|
| A1 | Sources and provenance | 01, phase 1 | 1 | contracts |
| A2 | Documents: properties, search, views, stable paths | 01, phase 2 | 1 | contracts |
| T | Response timer | 03 | 1 | contracts |
| B1 | Automations core: everything in 02 except section 3 and the "Done when" points that need external keys | 02 | 1 | contracts |
| A3 | Tasks and events: shared properties, links, backlinks, hub pages | 01, phase 3 | 2 | A1, A2 merged |
| B2 | Automations with sources: the mocked artemk end-to-end tests from 02 (sections 3 and 4), and run durations from T in the run log | 02 | 2 | A1, B1, T merged |

Wave 0: you, alone. Wave 1: A1, A2, T and B1 in parallel. Wave 2: A3 and B2 in parallel. Wave 3: integration and the final report.

## Wave 0: map the code, fix the contracts

1. Read `README.md` and `docs/architecture.md`, then map how documents, revisions, tasks, events, chats, runs, tools, approvals, notifications, migrations and tests are organised. Note the hotspot files that several packages will need to change (tool registry, models, routers, document save path, chat message component, Automations page, settings, sidebar).
2. Make sure the test suite runs on `main` and can run against a separate database. If there's no test setup, or none that can use its own database, build the smallest shared harness now, so every agent uses the same one.
3. Create the integration branch `integrate/fundamentals` from `main`. Commit the specs to it.
4. Write `docs/specs/CONTRACTS.md` and commit it. It fixes everything two packages could otherwise invent differently:
   - **Actor context (provenance):** how code learns who is acting (`user`, `chat:<id>`, `automation:<id>/<run id>`), its name and type, and where it's set. A1 implements it, B1 sets it for automation runs, A2 records it on document revisions.
   - **Object references:** the canonical URL for documents, tasks, events and chats.
   - **Property definitions,** including `applies_to`: A2 builds them, A3 extends them to tasks and events.
   - **New tables and columns per package,** with their names, so nothing is created twice.
   - **Timing fields** (T) on messages, runs and tool calls, which B2 shows in the run log.
   - **Tool changes per package:** which tools each package adds or changes. Where two packages change the same tool, who owns which parameter.
   - **Migrations:** each package keeps its own migrations and never edits another package's. At merge time you re-chain them so the history stays linear, in merge order.
   - **File ownership:** for each hotspot file, which packages may change it and how (add only: no reformatting, no moving or renaming existing code). Example: A1 adds the actor to the revision write, A2 adds indexing after the write, and neither restructures the save function.
5. Commit the small shared stubs the contracts need (e.g. the actor context with `user` as the default), so every branch starts from the same base. Stubs only, no features.
6. For each wave-1 package, create a worktree and branch from the integration branch: `git worktree add ../anemo-<id> -b feat/<id> integrate/fundamentals`. Give each its own database (`anemo_test_<id>`), its own Valkey database number or key prefix, and its own ports if it runs a dev server. Create a folder `../anemo-progress/` for progress notes outside the repo.
7. **Stop and show me** a short summary of the contracts and the plan. Ask me to confirm that I have a backup of the live database. Start wave 1 only after my OK.

## Briefing a builder

A sub-agent sees nothing but its briefing. Give every builder this, filled in:

```
You build one work package of a larger change to Anemo. Other agents build other packages at the same time, in other worktrees. You can't talk to them or to the user.

Package: <ID>, <name>.
Spec: docs/specs/<file>, <sections>. Read it in full; build only your part. <For B1: leave out section 3 and the "Done when" points that need external keys; they belong to B2.>
Contracts: docs/specs/CONTRACTS.md. Follow them exactly. If your work can't be done within them, stop and report what has to change and why. Don't work around them.

Where: worktree <path>, branch <branch>. Commit only there. Never push, merge or switch branches, and never touch main or other worktrees.
Environment: database <name>, Valkey <db/prefix>, ports <ports>. Never connect to the live Anemo instance or its database. The spec's backup rule is handled by the orchestrator.

The spec's ground rules apply: find before you build, keep the code clean, extend tools before adding new ones, keep the approval model, tests for every "Done when" point. Where the spec says "stop and tell me", stop and put it in your report.

Commit small working steps often, with clear messages. Keep ../anemo-progress/<id>.md up to date (done, in progress, next, blockers), so someone else can continue if you're cut off. The whole test suite must pass before your last commit.

Your final message is all the orchestrator sees. Report:
1. Each "Done when" point of your part, with the test that covers it, or why it isn't covered.
2. What you didn't build, and why.
3. Every design decision you made, and why.
4. Files you changed outside your package's own files.
5. Migrations you added.
6. Blockers and contract problems.
7. What the user has to check by hand in the UI.
```

## Review and merge

For every finished package:

1. **Review with a fresh sub-agent that didn't build it.** Give it the spec part, `CONTRACTS.md` and the diff (`git diff integrate/fundamentals...feat/<id>`). It checks every "Done when" point against the code and the tests, contract breaches, scope creep, changes to unrelated code, and the safety and privacy rules in the specs (approvals, untrusted content, project-scoped search, no customer data in events). It reports; it doesn't fix.
2. **Send real problems back** to the builder: resume it if your tool can, otherwise start a new sub-agent with the original briefing, the branch and the review.
3. **Merge in a fixed order**, whatever order the packages finish in: A1, T, B1, A2 in wave 1, then A3, B2 in wave 2. Re-chain the migrations, resolve conflicts, and run the full test suite after every merge. Fix small integration breaks yourself; send anything bigger than glue back to the package.
4. **Wave 2 starts** only when all wave-1 packages are merged and the suite is green. Create the wave-2 worktrees from the integration branch at that point.

## Contract changes during a wave

If a sub-agent reports that a contract has to change: decide it yourself if it stays within the specs' design; if the design itself has to change, ask me. Update `CONTRACTS.md` on the integration branch and note it in the log. Running sub-agents can't be told, so check every affected package against the new contract when it reports, and send it back if needed.

## Wave 3: integration and final report

- Run the full test suite on the integration branch.
- Run all migrations from zero on an empty database, and on a database seeded with realistic data: documents with and without front matter (one with broken front matter), tasks with tags, events, schedules. Check that every migration can be rolled back.
- Then report to me, short:
  - per package: status, its "Done when" points with tests, decisions worth knowing
  - all migrations, in order
  - what I have to test by hand in the UI
  - deploy steps and rollback steps
  - open questions
