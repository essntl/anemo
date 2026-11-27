# Spec 26: document organisation in the Documents sidebar

*Written 27 Nov 2026 against main `5fbbe48`, from Artem's brief. One job, two PRs.*

## The problem

The Documents sidebar (`frontend/src/features/documents/components/DocumentList.tsx`) is a
flat, virtualized list grouped only by folder (`listRows`). Titles are cut to one line
(several start with "Prompt: Anemo agent –", so they look the same), the meta line is cut
("by an a…"), and finished documents sit with the active ones. Artem wants it organised,
with a button that tidies it up.

## Features

1. **Group by and sort**, at the top of the list.
   - Group by Folder (today's behaviour, the default), Type, Status or Last changed
     (Today / This week / This month / Older).
   - Sort inside a group by Title or Last changed.
   - Type and status are the built-in properties (`type`, `status`). A document without
     one goes into "No type" / "No status", shown last.
   - The title search still works across groups. The list stays virtualized and can be
     used with the keyboard.
2. **Collapsible groups with counts, and Pinned.**
   - Every group header shows a count and folds; what's folded is remembered.
   - Pin or unpin a document from its row menu (also on right-click) and from the
     document's own menu. Pinned documents are listed first, whatever the grouping.
   - Pins are stored on the server (they sync across devices). In a project they're
     per project.
3. **Finished documents fold away.**
   - Documents with status `archived` (or `done`, if someone added that value) go into a
     folded "Archived (N)" group at the bottom, in every grouping.
   - A toggle hides that group completely.
   - "Archive" and "Unarchive" in the row menu change the status property (a revision).
   - The agent tools' `include_archived` doesn't change.
4. **Readable rows.**
   - The list can be made wider or narrower by dragging its edge; the width is
     remembered.
   - Titles wrap to two lines.
   - A prefix that several documents in a group share ("Prompt: Anemo agent – ") is
     shown fainter.
   - The meta line shows type and status chips and a short age ("2d"). When there isn't
     room, whole parts are dropped, the least important first; nothing is cut mid-word.
5. **Tidy up** (a separate PR). A button in the list's header asks a cheap model for
   suggestions about the documents in view. Artem reviews them and applies the ones he
   wants.
   - It looks at up to 200 documents and says so when there are more.
   - The model gets each document's title, folder, properties, last change and the first
     600 characters.
   - It may suggest:
     - a. type, status or tags (only values that already exist);
     - b. archiving what's clearly finished;
     - c. a shorter, clearer title (only for long or ambiguous ones);
     - d. a move to an existing folder (never a new folder).
   - A review dialog lists the suggestions by document. Every change has its own
     checkbox, and there are Accept all, Reject all and Apply selected.
   - Nothing changes before Apply. Every applied change goes through the normal document
     paths, so it gets a revision and an activity entry and can be undone.

## Decisions

- **PRs.** Features 1–4 are one PR (`docs-org/1-sidebar`), because they all change the
  same component. Feature 5 (`docs-org/5-tidy`) is **stacked on it**: its button and
  dialog live in the same sidebar header.
- **View choices are kept in browser storage** (`anemo.docList.view`, a small zustand
  store), not as a server setting. They're about this screen on this device, like the
  list toggle (`anemo.docList`) next to it. There's one entry per project and one for
  outside projects (Uncategorized and All share it). Each entry holds the group-by, the
  sort, the folded groups and "hide archived". The width (`anemo.docList.width`) is one
  value for all of them.
- **Pins get a table**, `document_pins`. Nothing pinned documents before: chats, memories
  and views each have their own `pinned` column. The table has `document_id` and a
  nullable `project_id` (null outside projects), both with ON DELETE CASCADE, and one pin
  per document and place. A column on `documents` wouldn't work, because pins are per
  project.
  - Endpoints: `GET /api/documents/pins?project_id=` (the ids, most recent first) and
    `PUT /api/documents/{id}/pin` `{project_id, pinned}`.
  - Uncategorized and All use the pins from outside projects.
- **"Finished"** means status `archived` or `done`. The built-in status values are draft,
  active and archived; `done` only counts if someone added it.
  - Archive sets `status: archived`.
  - Unarchive sets `status: active`.
  - Both go through `PUT /documents/{id}/properties` with no base hash, the same path the
    properties bar uses (a revision each).
  - A pinned archived document shows in Pinned (pinning is an explicit choice).
  - While searching, the folded groups open, so every match can be seen. A hidden
    Archived group stays hidden.
- **Last changed buckets**:
  - Today: since midnight.
  - This week: the 7 days before that.
  - This month: the 30 days before today.
  - Older: everything else.
- **Group order**:
  - Folders: by name, the top level first (as today).
  - Type and status: in the order of the property's values (Settings > Properties); a
    value that isn't in the list comes after the known ones.
- **Resizing.** Neither the chats nor the tasks sidebar can be resized today, so there's
  nothing to reuse. A generic `useResizableWidth` hook and a `ResizeHandle` component go
  into `hooks/` and `components/ui/` for the next list that needs them.
  - Minimum 200 px, maximum 480 px, default 240 px (today's `w-60`).
  - The handle works with the arrow keys, and a double-click resets the width.
  - Only from `md` up; on phones the list is the whole screen.
- **Shared prefixes.** A prefix counts when it ends at a separator (`:`, `–`, `—`, `-`,
  `|`, `/` followed by a space) and at least two documents in the same group start with
  it. The longest such prefix is used. It's shown in a fainter colour but kept, so the
  title reads as before.
- **The meta line**:
  - From left to right: the status chip (not for archived ones, since their group says
    it), the type chip, and a mark when an agent made the last change.
  - These sit in a one-line, wrapping row with its overflow hidden, so a part that
    doesn't fit drops out whole, the last one first.
  - The age stays at the right and is never dropped. It uses `Intl.NumberFormat` with
    narrow units ("2d", "3 h"), so no translations are needed.
  - Word count and "saved from the browser" are no longer shown in the row; the
    document's details panel has them.
- **Keyboard.** Tab works as before. The up and down arrows also move between rows and
  group headers, scrolling the virtual list, so rows that aren't drawn yet can be
  reached too.
- **Tidy up: a new endpoint next to the existing ones, not the suggestion table.**
  `PropertySuggestion` holds suggestions an agent left for later, one row per document,
  properties only. Tidy-up is a proposal made on request and reviewed straight away, so
  it isn't stored.
  - `POST /api/documents/tidy` takes `{document_ids (≤200), within}` and returns the
    checked suggestions.
  - `POST /api/documents/tidy/apply` takes the chosen changes and checks every one again
    before writing it.
  - The client sends the ids in its view: not the archived ones, the most recently
    changed first, at most 200. "The documents in this view" is then exactly what the
    list shows.
  - `within` is the project's folder in a project view. A move must stay inside it.
- **Tidy-up checks.** A suggestion is dropped:
  - when it names a document that wasn't sent;
  - when a property value isn't valid for that document (`properties.validate` with
    `create_values=False`, so no new tags or values either);
  - when it moves to a folder that doesn't exist, is where the document already is, or
    is outside `within`;
  - when it renames to an empty title, an unchanged one, or one longer than 120
    characters;
  - when it archives a document that already is.
- **Renames change the title, not the file name.** Links between documents are by id
  (`/documents/<id>`; `[[` opens a picker that inserts such a link), so neither choice
  breaks links in Anemo. But other tools, agents' notes and memories can name the file
  path, and keeping it is the safe option.
  - The new title goes where the title is read from (`title_of`): the front-matter
    `title` if there is one, otherwise the first `#` heading. Without either, a `title`
    is added to the front matter.
  - The renamed document is saved through `service.save` (a revision, an activity entry).
  - A move uses the same calls as the move endpoint (`service.move`, then
    `links.on_moved`), so task attachments and links follow and the old path keeps
    leading to the document.
- **The model** is the background model, `RouteRequest(task="summarization")`, as the
  relevance check uses.
  - The documents go in batches of 40, at most three at a time, each with a 90 s limit.
  - A batch that fails or times out is reported ("some documents couldn't be looked
    at"). The others still count.
  - It's called from the API process, as dictation's clean-up is. No job is queued: the
    user is waiting for the answer.
- **The fake model** answers the tidy prompt with fixed suggestions: archive for titles
  starting "Prompt:", type `note` for documents with no type. This makes an e2e test
  cheap. Tests can set `FakeAdapter.tidy_reply` to give the model any answer.
- **No agent tool.** `set_document_properties` has a suggest mode, but it only carries
  properties. Renames, moves and archives would need a new tool and a new review path,
  so this is left out (an agent can already do each change with the document tools).

## § Deviations

*(Filled in at the end.)*
