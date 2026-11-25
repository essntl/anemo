# Bulk task and event changes: many items in one tool call, one approval

"Move everything tagged *errands* to Friday", "finish these twelve", "push my Thursday
meetings to next week": until now an agent did that with one `update_task` or
`update_event` call per item, and with a permission level that asks, the user approved
each one. Two new tools change up to 100 tasks or events in one call, which the user
approves once, and which the activity log (spec 19) shows as one entry that can be undone
together.

Written with the code (November 2026). Contracts: [CONTRACTS-round4.md](CONTRACTS-round4.md) §4.

## What the agent gets

| Tool | Capability | What an item can do |
| --- | --- | --- |
| `update_tasks` | `tasks.write` | `title`, `status` (with `subtasks: finish \| keep`), `priority`, `due_date` / `due_time` / `clear_due`, `project` (`""`: none), `tags` (replace) or `add_tags` / `remove_tags`, `remind_minutes`, `parent_id` / `clear_parent`, `properties` (only the keys given change), or `trash: true` |
| `update_events` | `calendar.write` | `title`, `start`, `end`, `all_day`, `location`, `remind_minutes`, `properties`, or `trash: true` (the whole event or series), or `trash: true` with `occurrence` (cancel that one occurrence) |

```json
{"items": [
  {"id": "0193…a1", "due_date": "2026-11-27"},
  {"id": "0193…b2", "due_date": "2026-11-27", "add_tags": ["q4"]},
  {"id": "0193…c3", "trash": true}
]}
```

- 1 to 100 items per call (`batch.MAX_ITEMS`); each item names one task (or one event, or
  one occurrence of a series) at most once; an item must change something; an item that
  goes to the trash changes nothing else; `tags` and `add_tags` / `remove_tags` don't mix.
  Breaking one of these refuses the whole call before anything happens (argument
  validation), so the model fixes the call and nothing is half done.
- Notes, checklists, links, blockers, repeat rules and the source link stay with
  `update_task` / `update_event`: they are per-item edits with long values, and leaving
  them out keeps the batch schema small. Creating many items at once is not part of
  this: it doesn't fall out of an update (no ids, different fields, other risks), and
  `create_task` calls in one step work.
- `update_task` and `update_event` say in one sentence that several items at once go
  through the new tools.

### The result

One line per item, in the order given, under a head line:

```
2 of 3 tasks done; 1 failed.
1. ok: [0193…a1] Write report (todo; due 2026-11-27; tags work, q4)
2. error: [0193…b2] Finishing this task would leave 2 open subtasks. Call update_tasks again with subtasks='finish' or 'keep'.
3. ok: [0193…c3] Old idea: moved to the trash
```

An `ok` line is the item's new state as `list_tasks` / `list_events` show it (the same
`task_line` / `_describe`), so the model doesn't need to read the items again. `data` (for
the UI, not the model) has `items: [{id, ok, title, error?}]`, `done` and `failed`. The
call is an error result only when no item was done; `changed` is true when at least one
was, so an automation run records it among its changes.

## Design decisions

**New tools, not a batch form of the old ones.** The two options were a list of items
(or an `ids` list) on `update_task` / `update_event`, or new tools. New tools won:

- *How cheap models use them.* A tool that is either "one id and these fields" or "a list
  of items, each with fields" has two shapes, and small models mix them up (an `items`
  list plus a top-level `due_date`, an `id` and `ids` at once). Two names with one shape
  each are chosen correctly far more often, and the descriptions say which is for what.
  An `ids` list with one shared change would be shorter for "move these 12 to Friday", but
  can't express "spread these over the week" and needs the same "which fields apply to
  many" rules anyway.
- *The prompt cache.* Tool definitions are part of the cached prefix either way; what
  matters is that they don't change between runs, which both options satisfy. The cost
  is the size: the new tools add two compact schemas (about the size of `update_task`
  without its long fields), and they are feature tools (`tasks`, `calendar` in
  `FEATURE_TOOLS`, picked up from `TASK_TOOLS` / `EVENT_TOOLS`), so they go when the page
  is turned off. Folding them into `update_task` would have grown the one schema by the
  same amount and changed an existing definition's meaning.
- *One way to do each thing.* Each item is applied by the very function `update_task`
  uses (`change_task`, `change_event` in `tools/builtin/tasks.py` / `events.py`, split out
  of the single tools in a commit of its own, no behaviour change), and trash moves call
  the same service functions as `delete_task` / `delete_event`. So there is one way to
  change a task, with two entry points: one item with every field, many items with the
  common fields. Validation, recurrence (finishing a repeating task adds the next one),
  subtasks and blockers, properties and project rules, provenance (`updated_by_ref`,
  `record_changed`) and the external keys of synced items all hold, because none of it is
  re-implemented.

**A failing item doesn't stop the batch.** Every item runs in its own database session
and is committed by its service function, as a single call would be. If item 7 fails
(a task that's gone, an event whose new end is before its start, open subtasks), the
others still apply and the result says exactly which failed and why; the model can then
retry just those. Stopping at the first failure would leave a half-done batch anyway
(items 1-6 are committed) and make the model work out where it stopped; one transaction
for all would let one bad item undo 99 good ones, and the service functions commit, so it
would mean restructuring them (which round 4 doesn't do: A adds `record` calls in them).
An unexpected exception in one item is logged and reported as that item's error
(`failed: <type>`); it doesn't hide the other items' results.

**One approval for the batch.** `actions()` returns one list: first an action carrying the
call's summary ("Change 30 tasks: due → Fri 2026-11-27", "Change 4 tasks, move 2 to the
trash"), then one action per item with `Action.item` (what changes on it) and `Action.ref`
(its reference, `/tasks?task=<id>` or `/calendar?event=<id>`) and no summary. The
permission engine evaluates every action and combines them, so the existing approval
path (`runtime/tool_calls.decide`, the agent loop's `_ask`) asks once for the whole call,
unchanged. Because only the first action has a summary, the approval's summary (joined
from the actions' summaries, at most 500 characters) and the run history's one-line
description stay short however many items there are. Two optional fields on `Action`
(`policy/models.py`) were the smallest change: the run code, the approval table and the
API (`ToolCallOut.actions` is a list of dicts) needed nothing new. `resource` was not
reused for the reference, because *Allow for this run* derives its grant's scope from
`resource` (it is a path prefix for files).

**Risk, as for single changes.** A task change is `safe`, a task in the trash
`dangerous` (as `delete_task`); an event change or a cancelled occurrence `moderate`, an
event in the trash `dangerous` (as `update_event` / `delete_event`). The call's risk is
the highest of its items, so a batch with one deletion asks under the default level
("ask for dangerous"), and a batch of plain task changes runs without asking, like the
single calls it replaces. `create_value: true` (new property values) asks every time, as
for one item.

**Showing every item.** The actions know only ids (they are computed without the
database, before anything runs), so the approval card asks `POST /api/links/targets`
(new; refs in, `LinkItem`s out, in order, at most 100, built on the links feature's
existing `targets.describe`) for the titles. A batch of up to three items is listed at
once; a longer one shows the summary and **Show all 30 items**, which lists each item's
title (a link to it; *in the trash* or *not found* when it is gone) and what changes on
it, trash moves in red, in a scrolling list. The titles are fetched only when the list is
open; if that fails, the references are shown instead. Days carry their weekday ("Fri
2026-11-27") so a wrong date stands out.

**One activity group.** The whole batch runs inside `activity_group(label)`
(`app/core/activity.py`), with the label in the past tense: "Changed 12 tasks: due → Fri
2026-11-27", "Moved 3 events to the trash". Every activity entry the service functions
write meanwhile (workstream A) carries the group's id, so the Activity page lists the
batch as one entry that can be undone together. The tools write no activity rows
themselves.

**Not idempotent, a longer timeout.** `idempotent = False`: a batch cut short by a worker
crash must not be applied again blindly (the runtime then reports the call as
interrupted, and the model can check with `list_tasks` what happened). `timeout_s` is
180 s instead of 30 s, since 100 items each take a few database round trips.

## Security

- Nothing new is reachable: the capabilities stay `tasks.write` / `calendar.write`, every
  item goes through the same service functions and checks as a single call, and the
  permission engine sees every item's action (a denied or blocked one denies the call).
- The approval shows each item by its real title, looked up from the id by the server,
  never by a title the model wrote.
- `POST /api/links/targets` is behind login, read-only, bounded (100 references of at
  most 300 characters), and returns what the links panel already shows.

## Tests

- `backend/tests/api/test_bulk_changes.py`: per-item results and partial failures
  (unknown id, open subtasks, an event ending before it starts), tag adding and removing,
  projects, trash and cancelled occurrences; repeating tasks and finishing subtasks as
  `update_task` does; input limits (100 / 101 items, empty, duplicates, empty items,
  trash with other fields, tags with add_tags); the actions list (summary first, one item
  per task with its ref and risk, mixed batches, `create_value`); the activity group seen
  inside the service calls (one group for the batch, none afterwards); a worker-level run
  with the fake model asking once for 30 tasks, the approval's summary and actions, and
  all 30 changed after approving; a batch of plain changes running without asking;
  `/api/links/targets`; the fake agent model's batch path that the e2e test uses.
- `frontend/src/features/agents/components/BatchItems.test.tsx`: the approval card with 30
  items (summary, folded list, titles, one set of buttons), a short batch listed at once
  with trashed and missing items, references when the titles can't be loaded, an ordinary
  call without a list.
- `e2e/tests/bulk-changes.spec.ts`: an agent batch on four tasks asks once, the card lists
  them by title, and after *Allow once* all four have the new date.

## Limits and what's left

- No "shift by" for events (move every item one hour later): the model gives each item's
  new start. Worth adding if models get the arithmetic wrong.
- No bulk create, and no bulk changes of documents.
- The tools' result lines and the approval texts are in English, like the other tool
  summaries; the card's own words are translated.
- The user can approve or deny the batch as a whole, not item by item.
