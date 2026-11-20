# Prompt: Anemo agent – organisation, links and sources

I want you to improve how Anemo's documents, tasks and calendar events are organised and connected. Today a document's only metadata is its folder, tasks have free-form tags, events have nothing, and nothing connects the three. An example from my own data: the calendar event "Meeting website (at Oslo S)", the task "Ludmyla Doula: prototype ready for Saturday meeting" (tag `ludmyla-doula`) and the document "Ludmyla Doula: prototype brief" belong to the same client. Nothing ties them together, and the event doesn't even say which client it's for. After this work all three carry `client: ludmyla-doula`, they can link to each other, and the client's page lists all of them.

This prompt describes the design I want. Build it to this design. Where it clashes with the code as it is, stop and tell me what has to change.

The work has three phases. Build them in this order, and finish, test and commit each phase before you start the next:

1. **Sources and provenance:** where an event or task came from, and who created or changed what. Small, and my planned automations depend on it.
2. **Documents:** properties, search, views, stable paths.
3. **Tasks and events join in:** shared properties, links and backlinks across all three types.

## Ground rules

- **Find before you build.** Read `README.md` and `docs/architecture.md`. Then look up how documents are stored, saved, revisioned, chunked and embedded, how tasks and events are stored, and how `search_documents` ranks results. Don't guess at structure.
- **Design the shared parts for all three phases up front** (object references, property definitions that know which object types they apply to), even though phase 2 uses them for documents only. Don't build a documents-only model that phase 3 has to tear up.
- **Keep the code as clean as you found it.** The codebase was just refactored. Follow its existing structure and conventions, put new code where its kind of code already lives, and don't change unrelated behaviour. If the design here doesn't fit the structure, say so instead of bending the structure.
- **Extend existing tools instead of adding new ones where possible.** Every tool description uses up the model's context. Add a parameter when that's enough.
- **Keep the approval model** as it is. Reading needs no approval; changing follows the existing rules.
- **Don't merge the file tools with the document tools.** Plain files in `projects/` are out of scope.
- **Single user, a few hundred to a few thousand items.** Choose the simple solution that is correct at that size. No search cluster, no new services.
- **Data safety.** Before the first database migration, tell me to take a backup, or take one yourself if you can, and say where it is. Every schema change is a migration that can be rolled back.
- **Tests.** Add automated tests for every "Done when" point, in the project's existing test setup. If there is none, set one up in the simplest way the stack allows and say so. Run the whole suite before each commit.

## Shared foundation

- **Object references.** Every document, task, event and chat has a stable id and one canonical reference, which is also how it is linked from Markdown. Use the app's existing URLs (`/documents/<id>`, `/tasks?task=<id>`). If events or chats have none, add one in the same style.
- **Property definitions** carry an `applies_to` list (documents, tasks, events) from the start.

---

## Phase 1: Sources and provenance

### 1.1 Provenance: who made it

- Documents (per revision), tasks and events record who created them and who changed them last: `user` (in the UI), `chat:<chat id>`, or `automation:<automation id>/<run id>`.
- The server sets this from the context the request came from. The model never passes it and can't fake it.
- The UI shows it: "Created by the assistant in <chat title>" with a link to the chat, and each revision in a document's history shows who made it.
- A full change history for tasks and events is not part of this work. Creator and last change are enough for now.

### 1.2 Source: where it came from

Events and tasks get optional source fields:

- `source`: a short slug for the outside system, e.g. `artemk`
- `external_key`: the item's id there, e.g. `artemk:booking:123`. Unique per object type, trashed items included.
- `source_url`: a link to the original (e.g. the booking in the artemk admin)
- `synced_at`: when the source last wrote to it
- `edited_by_user_at`: set when I change a synced item by hand in the UI

Rules:

- `create_event` / `create_task` with an `external_key` that already exists creates nothing. It returns the existing item (id, its fields, and whether and when it was moved to the trash) and says to use `update_event` / `update_task`. No duplicates and no silent overwrites.
- A trashed item keeps its key. If I deleted a synced event, an automation must not recreate it on its next run: the tool result says "moved to the trash by the user on <date>; don't recreate it unless the user asks".
- When I've edited a synced item by hand, tool results include `edited_by_user_at`, so an automation can decide not to overwrite my change.
- `external_key` can't be changed once it's set. In the UI I can detach an item from its source, and it becomes an ordinary item.
- `list_events` and `list_tasks` get the filters `source` and `external_key`. `list_events` also gets a text `query`. With any of these filters, the date range of `list_events` is optional.
- New tool `get_event`: one event in full (description, source fields, provenance, and from phase 3 its properties, links and backlinks). Tasks have `get_task`; events have no such tool today.
- The UI shows a small source badge on synced items, linking to `source_url`.

### Phase 1 done when

- Creating an event twice with the same `external_key` gives one event, and the second call returns the first.
- Creating an event whose key belongs to a trashed event creates nothing and reports the trash.
- Editing a synced event in the UI sets `edited_by_user_at`, and `get_event` shows it.
- A task created in a chat shows that chat as its origin. One made in the UI shows that I made it.
- Existing create, update and list calls without the new parameters behave exactly as before.

---

## Phase 2: Documents: properties, search, views

### 2.1 The model: three layers, each with one job

| Layer | Answers | How many per document |
|---|---|---|
| **Folder** | Where does it live? Which project owns it? | Exactly one |
| **Properties** | What is it about? (client, tags, type, status, ...) | Any number, typed |
| **Views** | Show me everything that matches X | Saved queries; a document can appear in many |

Folders stay as they are and stay shallow. They are not used for categorising; properties are. Views are the "virtual folders" that allow sorting along several dimensions without copying files.

### 2.2 Properties

**Where they live.** The Markdown file is the source of truth. Properties are stored as YAML front matter at the top of the document:

```markdown
---
type: brief
client: ludmyla-doula
tags: [website, legal]
status: active
---
# Ludmyla Doula: prototype brief
```

Why: documents stay self-describing and portable, property changes get the existing revision history for free, and an agent reading a file sees its metadata.

Postgres holds a **derived index** of the properties (a `jsonb` column with a GIN index, or a separate table if that fits the code better). Rules:

- The index is rebuilt from the file on every save, through the normal document save path.
- At startup, and on demand, reconcile: any document whose content hash differs from the indexed one is re-indexed. This catches files changed outside Anemo (shell, sync).
- Property edits in the UI or through tools rewrite the front matter through the same save path, so they create a revision. Never write document properties to the database only.
- Invalid front matter (broken YAML, unknown type) must not block saving or lose content. Save the document, index no properties, and show a visible warning on the document.

The editor hides the raw front matter and shows a properties panel instead. `read_document` returns the properties as a short block above the content, so the model sees them without parsing YAML.

**Schema: properties are defined, not invented.** Without a schema, values sprawl (`ludmyla`, `Ludmyla Doula`, `client-ludmyla`) and filters stop working. So:

- **Property definitions** (stored in the database, editable in Settings): key, label, type, `applies_to`, scope (global, or limited to one or more projects), and for select types the list of allowed values.
- **Types:** `select`, `multi_select`, `text`, `date`, `number`, `checkbox`. Nothing else for now.
- **Select values** have a stable slug (stored in the file), a display label (shown in the UI) and an optional **hub document** (e.g. the client's main page). Changing a label touches no files. Renaming a slug or merging two values is an explicit operation that rewrites every affected item in one go, with a revision for each document.
- **Built-in global properties**, created on first run:
  - `type`: note, plan, brief, spec, prompt, meeting-notes, reference, ledger, daily (extendable)
  - `status`: draft, active, archived
  - `tags`: multi_select with an **open vocabulary**, shared with task tags in phase 3. New tags can be created without approval, but a near-duplicate of an existing tag is rejected with the existing one suggested (same after lower-casing and turning spaces into hyphens, or a very close spelling; pick a threshold and report it).
- All other select properties have a closed list of values. Project-scoped properties, e.g. `client` in Tech Services, are created by me or by the agent with approval.

**Folder defaults.** A folder can define default properties, inherited by documents created in it or below it:
`documents/tech-services/clients/ludmyla-doula/` → `client: ludmyla-doula`.
Defaults are written into the file when the document is created, so the file stays the truth. Moving a document into another folder offers to apply that folder's defaults; it never changes existing values silently. Daily notes (`documents/**/daily/`) get `type: daily` automatically.

### 2.3 Search

One search engine, used by the UI search box, the views and the `search_documents` tool.

**Ranking: hybrid.**

- **Keyword:** Postgres full-text search (`tsvector`) over title, body and property labels. Use the `simple` configuration, or detect the language per document, because the documents are in English, Norwegian and Ukrainian. Say in the report which you chose.
- **Meaning:** the existing pgvector embeddings, when an embedding model is set.
- **Combine** with reciprocal rank fusion. Exact title matches go first.
- **Contextual chunk header:** when embedding a chunk, put the document title, folder and key properties in front of it (e.g. `Ludmyla Doula: prototype brief | client: Ludmyla Doula | type: brief`). A chunk saying "the price is 4,000 kr" is useless if it doesn't know which client it belongs to. Re-embed a document when its title or properties change.

**Filters, applied before ranking.** Filters: folder (recursive prefix), project, any property (`=`, `in`, `has`, `missing`), `updated_after` / `updated_before`, `status`.

Filters must narrow the candidates before ranking, not after. Filtering the top-k vector results afterwards silently drops matches. Put the filters in the SQL `WHERE` of both the keyword and the vector query. For pgvector, use iterative index scans if the installed version supports them (0.8+); otherwise run an exact scan when the filtered set is small. Check the version and report what you did.

**Defaults that protect privacy.**

- **In a project chat, search defaults to that project.** Results from outside it are not mixed in. Instead the result ends with "N more matches outside this project", and the model can widen the search with `scope: "all"` when the request needs it. Reason: a search in the business project must not pull private documents (e.g. from the Nicole project) into business context by accident.
- **Archived documents (`status: archived`) are excluded by default** and included with `include_archived: true`. This replaces archive folders.

**Query syntax in the UI.** The search box accepts filters inline and turns them into chips: `client:ludmyla-doula type:brief in:tech-services price`. Typing `client:` suggests existing values. Unknown values show as an error chip, not ignored.

### 2.4 Views

A view is a saved query: filters, an optional search text, sort order and a layout.

- **Layouts:** list, table (properties as columns, sortable, editable in place) and board (grouped by a select property, e.g. status).
- Views are shown in the sidebar under their project. A project can pin views, e.g. Tech Services → "Clients" (table grouped by `client`), "Legal" (`tags has legal`).
- The hub document of a select value shows a generated list of every document with that value. This gives every client a page with everything about them, without moving files. Phase 3 adds tasks and events to it.

### 2.5 Stable references: moving must not break things

- Every move or rename is recorded in a path history (old path → document id).
- `read_document`, `edit_document` and links resolve an old path through the history and return the document, with a note: "moved to `<new path>`, update the reference". Only fail when the old path now belongs to a different document.
- Document tools accept a document id wherever they accept a path.
- When a document is moved, find project instructions and memories that contain the old path and offer to update them (an approval, not a silent rewrite).

### 2.6 Tools

Extend first, add only what is really new:

- **`search_documents`**: add `folder`, `project`, `properties` (an object of conditions), `updated_after`, `updated_before`, `scope` (`project` | `all`, default `project` in a project chat) and `include_archived`. Results show each document's key properties.
- **`list_documents`**: add the same filters, plus `group_by` (a property key). Without filters it behaves as it does now.
- **`read_document`**: returns properties above the content and accepts an id.
- **`set_document_properties`** (new): set or remove properties on one or more documents in one call. It rejects unknown keys and values not in the allowed list, and lists the closest existing values in the error. Adding a value to a closed list needs `create_value: true` and goes through approval, so the model reuses values instead of inventing near-duplicates.
- **`list_properties`** (new): the property definitions in scope, with their values and how many items use each. The model calls this before tagging.
- **`write_document`**: accepts `properties`; folder defaults are applied.

Tool descriptions must say that folders mean location and properties mean category, so the model doesn't create a folder per topic.

### 2.7 Migration

- Nothing is moved or tagged automatically. Existing documents work exactly as before, with no properties.
- Give the model a way to suggest properties for untagged documents in bulk. I review a table of suggestions and approve all, some or none. No AI tagging on every save (cost and noise).
- Existing filing rules documents (e.g. `documents/nicole/_filing-rules.md`) stay as they are. Don't change or replace them.

### Phase 2 done when

- A document can belong to client X and tag Y at the same time, and a view shows it under both.
- `search_documents` with `properties: {client: "ludmyla-doula"}` and a query returns only that client's documents, and no matching document is missing because of a top-k cut-off (test with a filter that matches few documents among many similar ones).
- In a Tech Services chat, a search for a word that also appears in Nicole documents returns no Nicole documents unless `scope: "all"` is set.
- Moving a document and then reading it by its old path works, with the "moved to" note.
- Editing a property in the UI creates a revision, and the change is in the file's front matter.
- Changing a file outside Anemo and restarting updates the index.
- Broken front matter never loses document content.
- Setting a near-duplicate value (`Ludmyla` when `ludmyla-doula` exists) is rejected with a suggestion.
- Existing documents, links and searches without filters behave as before.

---

## Phase 3: Tasks and events join in

### 3.1 Shared properties

- Tasks and events use the same property definitions as documents, where `applies_to` includes them. Their values are stored in the database, since they have no file.
- Task tags become the shared `tags` property. The `tags` parameter of `create_task` and `update_task` keeps working exactly as now, and existing tags are migrated without any visible change. Events get tags too.
- Project-scoped properties apply to the tasks and events of that project.
- `list_tasks` and `list_events` get the same `properties` filter as `search_documents`. `create_*` and `update_*` for tasks and events accept `properties`, with the same validation as `set_document_properties`.
- In the UI, properties show on tasks and events the same way as on documents. Table and board views can show tasks and events, alone or mixed with documents.
- Offer, as a suggestion I review and never automatically, to turn tags that name a client (like `ludmyla-doula`) into `client` values.

### 3.2 Links

- **One link index for all types:** from (type, id), to (type, id), origin, created by (provenance, as in 1.1), created at.
- **Two origins:**
  - **inline**: Markdown links in document bodies, task notes and event descriptions, extracted on save. They are derived, rebuilt on every save and never edited directly. Documents link only this way, so the file stays the source of truth.
  - **explicit**: links set in the UI or through tools on tasks and events, without editing their text, e.g. an event → its meeting notes, a task → the event it prepares for. They can point to documents, tasks, events and chats.
- **Backlinks.** Every document, task and event shows its links and what links to it ("Linked from"), grouped by type.
- **Dead links.** A link to a trashed item shows as "in the trash". A link to an item deleted for good shows as broken, and broken links are listed in one place so I can fix them.
- **Editor.** In documents, task notes and event descriptions, typing `[[` opens a picker over documents, tasks, events and chats and inserts an ordinary Markdown link with the canonical reference. The text stays plain Markdown.
- **Tools.** `create_task` and `create_event` get `links`; `update_task` and `update_event` get `links_add` and `links_remove` (all lists of references). `get_task` and `get_event` return links and backlinks. `read_document` returns its backlinks (the count and the first few). No separate linking tool.

### 3.3 Hub pages

The hub document of a select value now lists everything with that value, grouped by type (documents, tasks, events), plus everything that links to the hub itself. This is the client page.

### 3.4 Connecting things from the UI

- On an event: "Create meeting notes" makes a document with the event's properties, linked both ways.
- On a document or an event: "New task" makes a task with the same properties and a link back.

### Phase 3 done when

- The Ludmyla example from the top works: the event, the task and the brief all carry `client: ludmyla-doula`, and the hub page shows all three.
- Linking the event to the brief shows the event under "Linked from" on the brief. Moving the brief to another folder keeps the link.
- `create_task` with `tags` works exactly as before, and the migrated tags show up as the shared `tags` property.
- `list_tasks` with `properties: {client: "ludmyla-doula"}` returns only that client's tasks.
- A link to a trashed task shows as "in the trash"; a link to a task deleted for good appears in the broken links list.

---

## Not in scope

- Database blocks or tables inside documents.
- Typed link kinds beyond the existing subtasks and `blocked_by`, and a graph view.
- Nested or computed properties, formulas.
- Properties on plain files in `projects/`.
- Links inside chat messages.
- A full change history (activity log) for tasks and events. It's planned separately.

## Report

After each phase: what you built, what you didn't, every design decision you made and why, and anything in the existing code that got in the way.
