# Activity log with undo

Status: built in `feat/activity-log` (round 4, workstream A; CONTRACTS-round4.md §3).

## 1. Goal

One list of what was changed, by whom, and a way to undo it. Before this, the pieces were
spread out: `audit_log` has security events only, provenance says who created an item and
who changed it last, an automation run lists its changes (`runs.changes`), an agent's file
change can be reverted from its run, deleted tasks and events wait in the trash. Nothing
answered "what did the assistant (or that automation, that plugin) change today, and how
do I put it back?" in one place.

## 2. What it does

- **Every change gets an entry**, whoever made it: you (the app, the browser extension),
  the assistant in a chat, an automation run, a script, a plugin, and runs that an event
  trigger started (they are automation or chat runs). Recorded for:
  - tasks: created, changed (only the fields that changed), completed, deleted (to the
    trash), restored from the trash; a subtask finished with its parent and a status change
    by dragging on the board each get their own entry;
  - calendar events: created, changed, deleted, restored; cancelling one occurrence of a
    repeating event (undone from the trash), changing one occurrence (logged, not undoable
    here);
  - documents: created, text changed, moved, deleted;
  - workspace files: every file change an agent's tool makes (created, changed, moved,
    deleted, folder made), and in Files your moves, deletions and restores from the trash;
    reverting an agent's change from its run;
  - projects: created, changed (name, colour, archived, instructions).
- **Undo** per entry where an inverse exists, and for a whole batch at once:

  | Entry | Undo |
  | --- | --- |
  | A field change of a task, event or project | sets the changed fields back to their before-values, through the same service (reopening a task blocks what waits on it again) |
  | A task or event deleted, an occurrence cancelled | restores it from the trash |
  | A task, event or document created, or restored from the trash | deletes it, to the trash (so the undo itself can be undone from there) |
  | A document's text changed | restores the text before, from the document's revision |
  | A document or file moved | moves it back |
  | A document or file deleted | restores the file from the workspace trash |
  | An agent's file change | reverts it (`workspace/revert.py`) |

  An undo first checks that the item is still as the entry left it. If not, it refuses with
  `409 activity_conflict` and what differs (`details.differs`: field, expected, current);
  `force` undoes it anyway, as for reverting an agent's file change. Deleting a created item
  is refused while later, not undone changes to it are in the log. An undo writes its own
  `undone` entry and marks the original undone; neither can be undone again from the log
  (change the item itself, or use the trash).
- **Batches**: a tool that changes many items in one call (workstream B's bulk changes)
  runs inside `activity_group(label)` (`app/core/activity.py`); its entries share
  `group_id` and the page shows them as one row ("Moved 12 tasks to Friday (12 changes)")
  that opens. *Undo all* undoes the batch newest first, each entry on its own, and reports
  per-item results; the undo entries form a group of their own ("Undid: …").
- **The page** `/activity` (Settings → Pages: under *More*; in the command palette):
  entries newest first with who ("You", "The assistant in ‹chat›", "Automation ‹name›",
  "Script ‹name›", "Plugin ‹name›", with links), what (verb, kind of item, the item's name
  now with a link, the fields), when, and Undo (disabled with the reason when it can't be
  undone). Filters: who (you, the assistant, automations, scripts, plugins, started by an
  event), what (tasks, events, documents, files, projects), when (24 hours, 7 days, 30
  days). A task's, event's or document's details have a **History** link: the page
  filtered to that item. "Show more" loads the next page.
- **Kept 90 days**, pruned by the worker once an hour.

## 3. Decisions and why

- **One writer, one line per call site.** `record()` is the only function that adds rows;
  the services call small helpers (`activity.created`, `.changed`, `.deleted`, …) next to
  the provenance calls, so the services aren't restructured (B appends functions to the
  tasks and calendar services this round; T observes them from an ORM listener). The entry
  is part of the change's own transaction: it exists only if the change committed.
- **Snapshots, not hand-written diffs.** A service takes a snapshot of the item's fields
  before a change and after it (`snapshot(row, TASK_FIELDS)`); `diff()` keeps only what
  differs. That catches side effects inside the service (moving a task to another project
  drops properties) without each call site listing what it changed. `properties` is
  compared key by key (the `tags` property is left out: the `tags` field is the same
  thing). Instants are stored in UTC so an event saved with `+01:00` compares equal later.
- **Small entries.** A value longer than 2000 characters (as JSON) is kept as its SHA-256
  only: enough to tell whether the item still is as the entry left it, not to put it back
  (the entry says `too_large`). A document's text is never copied: the entry names the
  revision that holds the text before the change (`document_revisions`).
- **Document saves join an entry like revisions do.** The editor autosaves every few
  seconds; one entry per save would bury everything else. A save continues the newest
  entry when it is by the same actor and the save joins the revision that entry left (the
  revision window, 10 minutes). When there is no such entry, the save starts a revision of
  its own, so the text before it stays in the history and the change can be undone (before,
  such a save could merge into an older revision and overwrite the text before it). Edits
  right after creating a document belong to its *created* entry, as they belong to its first
  revision.
- **Agents' file changes come from a flush listener** on `run_file_changes`
  (`before_flush`): every place the worker stores one (agent runs, script runs) gets its
  entry without editing `runtime/` (workstream T's this round). A document written with the
  document tools gets only the document's entry: the documents service notes the (path,
  hash) it wrote, and the file change for the same write is skipped.
- **The undo goes through the services, with recording off.** Undoing calls
  `update_task`, `restore_event`, `documents.save` and so on, so every rule of those
  services applies; `activity.suppressed()` keeps them from writing entries of their own,
  and the undo writes exactly one `undone` entry. The entry is marked undone *before* the
  service runs, so the mark and the change are committed together (the services commit as
  they finish) or rolled back together.
- **Conflict check by values.** For field changes the current values of the changed fields
  are compared with the entry's after-values (also catching changes that bypass the log,
  such as an outside edit of a document's file). Deleting a created item instead checks
  for later entries about it, since any change would be lost with it.
- **Who is a "script" or "trigger".** Both are automation runs: a script is an automation of
  kind `script` (looked up from the id in `automation:<id>/<run>`, so it works after the
  run is deleted); "started by an event" is a run whose `options` hold an `event`
  (CONTRACTS-round4 §1.3, T's).
- **Labels are looked up when read**, like provenance: an entry shows the task's title now
  (or the title in the trash), the chat's title now. The stored `summary` is a short English
  sentence for logs and tools; the page composes its own translated text from the action,
  the kind of item and the field names.
- **Ordering.** Entries get their time in Python, never equal to the previous one, and are
  listed by (time, id); a batch's newest-first order is its undo order.

## 4. Data and API

Table `activity` (migration `0082`, after `0080`): `id`, `created_at` (indexed), `actor_ref`,
`action` (`created | changed | completed | deleted | restored | reverted | moved | undone`),
`object_type` (`task | event | document | file | project`), `object_id` (a UUID, or a
workspace path), `summary`, `before`, `after`, `undo` (`{"kind": "fields" |
"trash_restore" | "delete_created" | "revision" | "file_revert" | "file_trash_restore",
…}`), `group_id` (indexed), `group_label`, `run_id`, `undone_at`, `undone_by`. Indexes also
on (`object_type`, `object_id`, `created_at`) and (`actor_ref`, `created_at`).

- `GET /api/activity?actor_kind=&actor_ref=&object_type=&object_id=&since=&until=&group_id=&cursor=&limit=`
  → `{items: ActivityOut[], next_cursor}`. `actor_kind`: `user | assistant | automation |
  script | plugin | trigger | external`. `ActivityOut` has the actor (`ActorOut`, as
  provenance), `object_label` / `object_url` (looked up now), `fields`, and `undo_blocked`
  (`undone | is_undo | not_undoable | too_large`, or null when Undo can be tried).
- `POST /api/activity/{id}/undo?force=` → `{message, entry}`; 409 `activity_conflict`,
  `activity_unavailable` (the item or what undoing needs is gone), `activity_undone`,
  `activity_is_undo`, `activity_not_undoable`, `activity_too_large`.
- `POST /api/activity/groups/{group_id}/undo?force=` → `{results: [{id, ok, message, code,
  details}]}`, newest first; 404 for an unknown group.

## 5. Code

- `backend/app/features/activity/`: `models.py`, `service.py` (record, the call-site
  helpers, the file-change listener, listing and filters, object labels, prune), `undo.py`
  (one function per undo kind), `router.py`.
- Call sites: `features/tasks/service.py`, `calendar/service.py`, `documents/service.py`,
  `projects/service.py`, `files/router.py` (move, trash, restore), `runs/agent_router.py`
  (revert). Prune: `jobs/scheduler.py`. Page id: `settings/sections.py`.
- `frontend/src/features/activity/`: `ActivityPage.tsx`, `api.ts`, `labels.ts`, `rows.ts`
  (batches as rows), `HistoryLink.tsx` (in the task dialog, the event dialog and a
  document's details).
- The fake provider's demo agent renames a task when asked, for the e2e test.

## 6. Security

Undo is for the user only: an HTTP endpoint behind login, no agent tool, so an agent can't
undo the user's changes (or another run's) to cover its tracks. It can only put things back
through the same services and checks as any edit, never more: it can't restore a task that
was deleted for good (purged from the trash), a file the workspace trash no longer has, an
agent's file change whose run (and backup) is gone, a document text whose revision was
pruned (50 per document), or a long value it didn't keep. It refuses to overwrite later
changes unless forced. Entries hold ids, field values (capped) and paths, no file contents
and no message contents; titles an agent wrote are shown as text, never as markup.

## 7. Tests

- `backend/tests/api/test_activity.py`: entries at each call site (tasks, events and one
  occurrence, documents, files by an agent and by the user, projects), one per actor kind
  (user, chat with run id, automation, script, plugin, trigger-started), undo of each kind
  with conflicts and force, already undone and undo entries, group undo with a conflict
  then forced (inside `activity_group()`, as B's tools do), filters, cursor paging, prune,
  the fake agent's rename.
- `backend/tests/unit/test_activity_values.py`: diff, properties, capping and hashes, UTC
  instants, summaries, why an entry can't be undone, the fields shown.
- `frontend/src/features/activity/ActivityPage.test.tsx`: the list, actors and links,
  Undo with the "changed since" question and force, a batch row that opens and *Undo all*,
  the history of one item from the address, the actor filter, `toRows`.
- `e2e/tests/activity.spec.ts`: the demo agent renames a task, the change shows on
  /activity as the assistant's, Undo puts the title back, the item's history.

## 8. Limits and what's left

- Not logged: task and event changes made outside these services (links added in the link
  panel, a tag renamed across items, detaching a synced item), a document changed outside
  Anemo (it gets a revision, as before), your own file uploads, copies, new folders and text
  saves in Files (no backup is kept of the text before, so they couldn't be undone),
  memories, automations, settings (security events stay in `audit_log`).
- A deleted document restored from the trash comes back as a new document (the index finds
  the file again); its history stays with the old id.
- Undoing the completion of a repeating task reopens it without its rule; the next one,
  made when it was finished, stays and repeats.
- An undo in uk/ru shows the server's message (English) in its toast, as other server
  messages do.
- `runs.changes` stays as it is; the run page and the activity log are separate lists. A
  later step could show a run's entries on its page (`run_id` is stored for that).
