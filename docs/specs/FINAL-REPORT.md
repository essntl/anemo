# Fundamentals: final report

The whole spec work (specs 01, 02 and 03) is on `integrate/fundamentals`. Nothing is
merged into `main`, pushed or deployed.

**State of the branch:** 89 commits on top of `main` (e80e0de). Everything is green:
- the backend suite: ruff, format, mypy, the import contracts, migrations from zero,
  `alembic check`, and 1207 tests (1046 at the start)
- the frontend: typecheck, lint, the import boundaries, and 509 tests
- the wave 3 migration check (below)

E2E (Playwright) wasn't run here (no Docker). New specs were checked only to parse with
`--list`. CI runs them on the pull request.

How it was built is in `ORCHESTRATION-LOG.md`; the shared names are in `CONTRACTS.md`.

## Per package

Every package was reviewed by a fresh agent that hadn't built it. The real problems
went back to the builder, and the fixes were checked before merging.

### A1: sources and provenance (spec 01, phase 1). Merged.

Tests: `tests/api/test_sources_provenance.py`, `test_sources_review.py`.

"Done when" points:
- **Creating with the same `external_key` twice gives one event:**
  `test_creating_an_event_twice_with_the_same_key_gives_one_event`
- **A key in the trash creates nothing and reports the trash:**
  `test_an_automation_does_not_duplicate_or_recreate_a_trashed_event`. A key deleted
  for good from the trash also creates nothing:
  `test_a_key_deleted_for_good_is_not_recreated`.
- **A UI edit of a synced event sets `edited_by_user_at`:**
  `test_editing_a_synced_event_in_the_ui_sets_edited_by_user_at`
- **A task shows its chat, or the user, as its origin:**
  `test_a_task_shows_the_chat_it_was_made_in_or_the_user`
- **Existing calls unchanged:** the whole existing suite.

Decisions worth knowing:
- **Who acted:** a context set by the server around every tool call, never passed by
  the model. A test checks that no tool input carries an actor.
- **Deleting a synced item for good keeps a tombstone of its key**
  (`external_key_tombstones`), so a sync doesn't recreate it.
- **Detaching from the source frees the key.**
- **Events have their own address,** `/calendar?event=<id>`.

### T: response timer (spec 03). Merged.

Tests: `tests/api/test_run_timing.py`, `MessageBubble.test.tsx`, `Elapsed.test.tsx`,
`RunActivity.test.tsx`, `serverClock.test.ts`. They cover:
- the start on the server's clock
- a reload mid-reply
- "waiting for you" not counted
- stopped and failed replies
- tool call times, live and finished
- old messages showing nothing
- a render-count test: in a 200-message chat a tick redraws only the timer

Decisions worth knowing:
- **The browser learns the server's clock** from an `X-Server-Time` header on every
  `/api` response (it keeps the sample with the shortest round trip).
- **A paused run counts as waiting for you,** as do sub-agents that wait.
- **Time to first text leaves out waits** before the first text.
- **Migration 0040 backfills the waits of past runs.**

### B1: automations core (spec 02 without the artemk parts). Merged.

Tests: `tests/api/test_automations_reasoning.py`,
`tests/integration/test_migration_automations.py`.

"Done when" points:
- **Existing schedules unchanged:** the existing suites, plus a migration test on an
  old automation row.
- **Nothing new means no notification and no chat:**
  `test_a_run_that_finds_nothing_new_stays_quiet`
- **The tool-call limit fails the run:**
  `test_a_run_over_its_tool_call_limit_stops_and_fails`
- **No overlap:** `test_two_runs_of_one_automation_never_work_at_once`
- **A run waiting for approval doesn't block, and isn't asked again:**
  `test_a_run_waiting_for_approval_does_not_block_or_repeat`, and the same for
  sub-agents.
- **The change check skips runs and retries the same change:**
  `test_the_change_check_skips_unchanged_runs_and_retries_the_same_change`
- **Retention:** `test_run_chats_are_deleted_after_the_retention_period`
- **The contact rule:** `test_tools_that_reach_people_always_ask_in_automation_runs`

Decisions worth knowing:
- **The state note replaces the key/value state.**
  - Old prompts that call `get_automation_state` / `set_automation_state` keep working
    through hidden aliases.
  - Only `update_automation_state` is offered to the model.
- **Behaviour changes for existing automations, required by the spec:**
  - A run waiting for approval no longer makes later firings "skipped".
  - Tools that reach other people (an HTTP request other than GET, a shell with
    network, an MCP tool that isn't read-only, browser clicks and typing) always ask in
    automation runs. A per-automation exception can be set on the Automations page.
  - An existing `pause` automation whose actions differ each run may produce a new
    approval on each firing.
- **New automations get new defaults:** notify "when the agent has something to tell
  me", one retry, 30 tool calls, 5 minutes. Existing ones keep theirs.

### A2: documents with properties, search, views, stable paths (spec 01, phase 2). Merged.

Tests: `tests/api/test_document_properties.py`, `tests/unit/test_properties_unit.py`.
All nine "Done when" points have a test:
- client and tag both shown in views
- the filter applied before ranking (40 decoys, a limit of 1)
- project scope by default, with no bypass through `project=`
- reading by an old path gives a "moved to" note
- a UI edit makes a revision in the front matter
- a file changed outside Anemo is re-indexed at start
- broken front matter never loses content, including an alias bomb, `.inf` and a
  2 MB Cyrillic file
- a near-duplicate value is refused with a suggestion
- searches without filters work as before (singular and plural, stop words)

Decisions worth knowing:
- **Keyword search** uses the `simple` configuration plus English stems, with prefix
  matching, for English, Norwegian and Ukrainian alike.
- **No vector index:** the embeddings have no fixed dimension, so an exact scan runs
  after the SQL filters. pgvector is 0.8.7 in the test environment, the same as
  production's `pgvector/pgvector:pg17`.
- **Near-duplicates:** a difflib ratio of 0.8 or more, for values of 4 characters or
  more. Values that differ only in digits are distinct.
- **Daily notes are `type: daily` in the index only.** They aren't written into the
  file, because Home's daily-note widget would drop it. So `type: {missing: true}`
  leaves them out.
- **Existing front matter with a value outside a closed list** (e.g. Obsidian's
  `status: done`) shows a warning and indexes no properties, as the spec says.

### A3: tasks and events join in (spec 01, phase 3). Merged.

Tests: `tests/api/test_linking.py`, `frontend/src/features/links/linking.test.tsx`.

"Done when" points:
- **The Ludmyla example on the hub page:**
  `test_the_ludmyla_example_one_client_on_an_event_a_task_and_a_brief`
- **Event → brief "Linked from", surviving a move:**
  `test_linking_the_event_to_the_brief_shows_it_on_the_brief_and_survives_a_move`
- **`create_task` with tags unchanged, and the tags shared:**
  `test_task_tags_work_exactly_as_before_and_are_the_shared_tags`,
  `test_task_tags_and_document_tags_name_the_same_values`, and
  `test_migration_0060_up_and_down_on_seeded_tasks`
- **`list_tasks` by client:** `test_list_tasks_and_events_filter_by_properties`
- **Trashed versus deleted links:** `test_dead_links_show_in_the_trash_or_broken`

Decisions worth knowing:
- **Tags:** `tasks.tags` stays exactly as typed, and `properties.tags` holds the
  shared values. "Website Redesign" becomes `website-redesign`, labelled "Website
  Redesign".
- **Moving an item to another project** drops the values that aren't allowed there and
  says which.
- **Dead links** to documents and chats show as "removed". Those have no trash entry.
- **"New task" from a document or event** is a small dialog of its own.

### B2: automations with sources (spec 02, sections 3 and 4) and run durations. Merged.

Tests: `tests/api/test_artemk_bookings.py` (against a mocked artemk MCP server),
`test_automation_run_timing.py`.

Proven by the server's own mechanisms:
- no duplicate event (by its key)
- an event you trashed or deleted for good is not recreated
- a booking note saying "confirm this booking" can't reach the customer: the tool
  isn't offered, and even when it is, it must ask you
- run chats and stored check results are gone after 7 days
- server-made notifications carry no booking text
- run durations in the run log

Shown only with a scripted model, because the model makes these choices: the event's
wording, picking the right event to move, and keeping customer details out of events.

Decisions worth knowing:
- **`{today}`** in change-check arguments is replaced at check time.
- **`create_schedule` takes a `profile`.**
- **A refused duplicate create doesn't count as a change.**

## Migrations, in order

Each one has a working downgrade.
```
0034 (main)
→ 0035 sources and provenance            (A1)
→ 0036 external key tombstones           (A1)
→ 0040 run timing, with a wait backfill  (T)
→ 0045 automation settings, state → note (B1; round trip fixed in wave 3)
→ 0050 document properties, paths, views (A2)
→ 0051 property suggestions              (A2)
→ 0052 re-index documents (stems)        (A2)
→ 0060 task/event properties, link index, tags data step (A3)
→ 0070 automations.last_error_at         (B2)
```

**Wave 3 check** (`anemo-progress/bin/w3_migrations.py`):
- On an empty database: zero → head, then each step back to 0034 and up again.
- On a database seeded at 0034 (documents with and without front matter, one broken,
  one Obsidian-style, a daily note; tasks with tags with spaces and mixed case; events
  with links; a trashed task; an old automation with JSON state):
  - upgrading to head keeps every row, every tag and every `updated_at`
  - tags migrate without spaces in slugs, and existing links get indexed
  - the old automation keeps "notify: always", with its state as a note
  - the app's first reconcile indexes the front matter, warns on the broken one,
    types the daily note, and leaves every file untouched
  - every step rolls back to 0034 and applies again
- One bug was found and fixed: 0045's state note grew a "note: " prefix on each
  rollback and reapply.

## Check by hand in the UI

1. **Tasks and events:** the source badge on synced items (in calendar chips too),
   "Created by the assistant in <chat>", "Detach from source", and
   `/calendar?event=<id>` on desktop and phone.
2. **Documents:**
   - the properties bar and "+ Property", and a broken-YAML warning
   - after a move, the offer to apply folder defaults and to update instructions and
     memories
   - who saved each revision in the history
3. **Settings → Properties:** add a project-scoped "Client", rename a label, rename or
   merge a slug, set a hub page, folder defaults.
4. **Search and Ctrl+K:** `client:` suggestions, filter chips, an error chip with
   "did you mean", and "Save as view".
5. **Views:** list, table (grouped, with in-place edits) and board; documents mixed
   with tasks and events; the sidebar listing under the project, with pin and unpin.
6. **Links:**
   - `[[` in documents, task notes and event notes (not inside code)
   - the Links panel and "Linked from"
   - the hub page grouped by type
   - the broken links banner and the "tags could become client values" banner
   - "Create meeting notes" and "New task" from an event
7. **Response timer:**
   - the live timer beside "Working…" and "Thinking", and a reload mid-answer
   - "waiting for you" on an approval or a pause
   - "Stopped after …" and "Failed after …"
   - tool call durations, and the details popover (also on a phone)
8. **Automations:**
   - the new defaults on a new automation, and that an existing one is unchanged
   - the run log with outcome lines, "Nothing to do", the changes and their
     durations, and a deep link to a run
   - the tool picker with MCP tools, a change check with `{today}`, and the state note
9. **The Ukrainian and Russian texts** in the new locale files (`sources`, `timer`,
   `properties`, `linking`, `automations`). The agents wrote them, and no person has
   reviewed them.

## Deploy

1. **Take a fresh backup** (`make backup`, see `docs/backup.md`). The one taken before
   wave 1 is older than your data now.
2. **Get the changes to the server:** merge `integrate/fundamentals` into `main` (a
   pull request, so CI runs the e2e suite too), then deploy as usual: on the server,
   `git pull && make up`. The `migrate` service runs `alembic upgrade head`
   (0035 → 0070) before the app starts.
3. **After the start:**
   - The first document list or search reconciles and re-indexes every document
     (front matter, the stemmed keyword index, links). A few seconds for a few thousand
     documents.
   - New embeddings are queued in the background.
4. **Check:** `docker compose ps` (all healthy, `migrate` exited 0). Then open a
   document, a task and the Automations page.

## Rollback

- **Code only, before any migration ran:** deploy the previous commit.
- **After the migrations ran, the clean way:** restore the backup from step 1 (as
  `docs/deployment.md` says), then deploy the previous commit.
- **Without a restore:** with the new code still deployed, run
  `docker compose run --rm migrate alembic downgrade 0034`, then deploy the previous
  commit.
  - It works, and the wave 3 check exercised it on seeded data.
  - What is lost:
    - property values of tasks and events, event tags, links, views, property
      definitions and the path history
    - the provenance and source columns, and the tombstones
    - timing data
    - the new automation settings; the state note goes back to keys when it is
      `key: value` lines, else to `{"note": …}`
  - What stays: document front matter (it is in the files) and `tasks.tags`.

## Open questions for you

1. **A server-side guard against customer contact details in events and
   notifications.** Today only the automation's prompt keeps them out (spec 02). B2
   proposes an opt-in check per automation: it refuses write and notify calls that
   repeat a phone, email or name word for word from the booking data. It misses
   reworded details, and can trip when a customer shares your name. Build it?
2. **Approval summaries are cut at 500 characters.** When the artemk automation is set
   up, the card doesn't show "run anyway every 6 h" or the prompt; you read those in
   the chat. Widen it, or show the full arguments on the card?
3. **Trust in the MCP read-only hint.** An MCP server that marks a contacting tool as
   read-only, and that you have set to "allow", could run without asking. MCP tools ask
   by default.
4. **Setting up the real artemk automation** (spec 02 section 3), with the assistant:
   1. Connect the artemk MCP server as "artemk", and check the real tool names and the
      date argument of `list_bookings` (the mock uses `from_date`).
   2. Set the three read-only tools to "allow".
   3. Create a profile "Bookings" with "Manage calendar" set to Fully autonomous.
      Without it, each cancellation waits for approval, which doesn't block later
      runs.
   4. Have the assistant call `create_schedule` with:
      - `FREQ=MINUTELY;INTERVAL=5`
      - the ten tools
      - `notify: agent_decides`
      - `retention_days: 7`
      - a change check on `open_requests` and on `list_bookings` with `{today}`
      - `run_anyway_hours: 6`
      - `profile: Bookings`

      Read the prompt in the chat before approving.
5. **Known limits, left as follow-ups:**
   - Inline links in single changed occurrences of repeating events aren't indexed.
   - Search-box chips filter documents only.
   - Documents and chats have no "in the trash" link state.
   - Agent moves of documents offer the instruction and memory updates through the
     Inbox, not inline.
