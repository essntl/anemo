# Chat recall: the agent searches and reads earlier chats

"What did we decide about the website last week?" Until now an agent had no way to look
at earlier conversations: memories extracted from chats were the only bridge, and the
user had to find the chat themselves and attach it as a reference. Two read-only tools
close that gap: `search_chats` finds earlier chats, `read_chat` reads one, a page at a
time. Both sit under a new permission, **Read earlier chats** (`chats.read`).

Built in round 4 (November 2026) from `CONTRACTS-round4.md` §5.

## How you use it

- In Agent mode, just ask about an earlier conversation. The agent searches (the run's
  activity shows *Search earlier chats (this project's chats) for "…"*), and reads the
  chat it found from the matching message on.
- **Settings → Agent Permissions → Read earlier chats**: default *Fully autonomous*.
  *Always ask* makes every search and read wait for you; *Never* removes both tools.
- **Automations** don't get these tools unless their tool list (Run settings → Tools)
  names `search_chats` and/or `read_chat`. An automation without a list gets every other
  tool as before.
- Not in Chat mode: like the other tools (except memory and images), they need Agent mode.

## The tools

### `search_chats`

Input: `query` (words, a "phrase", `-word`, or a question; up to 500 characters),
`scope` (`"project"`, the default, or `"all"`), `limit` (1–20, default 8).

- **By words**: the existing Postgres full-text search over `messages.text_plain` (the
  `tsv` column the search page and Ctrl+K use, now one helper:
  `features/conversations/search.py`), and the chat titles (every word, as on the search
  page).
- **By meaning**, when an embedding model is set: the messages of ordinary chats are in
  the knowledge index (below). Index hits are only kept if the chat is visible in the
  scope (the index knows nothing of scopes, so five times the limit is asked for).
- The three rankings (message words, titles, meaning) are merged by reciprocal rank
  fusion, as `knowledge/index.py` merges its two.
- **Scope**: the current chat's project; in a chat without a project, the chats without
  one. `"all"` looks everywhere. A scoped search also says how many chats elsewhere
  match by words ("3 more chats outside this project match. Ask again with scope:
  "all" only if the request needs them."), as `search_documents` does.
- **Result**, per chat: title, id, date of the last message, project (or "no
  project"), "archived", "an automation run", "found by meaning" where it applies, and
  up to three matching messages as `seq N, the user|assistant: «snippet»`. The `seq`
  goes into `read_chat`'s `around_seq`. `data` (for the UI, never sent to the model):
  `chats: [{id, title}]`, `outside_project`, `by_meaning`.

### `read_chat`

Input: `chat_id`; at most one of `around_seq` (half the page before it, the rest from
it on), `after_seq`, `before_seq`; `limit` (1–50, default 20). Without a position: from
the start.

Each message reads as text:

```
[seq 12] The user, 2026-11-02 14:03 UTC:
[attached file: plan.pdf]
Can you check my notes?

[seq 13] Assistant (Claude Sonnet):
[tool read_file: Read notes/todo.md]
[tool write_file: Write notes/todo.md (denied)]
Your notes say: ship it.
```

- **Tool calls** of the answer's run: one line each, the action summary the approval
  and the timeline show (or the tool name), with the status when it didn't succeed; at
  most 20 per answer. Their results are not repeated (the answer says what came of them).
- **Attachments, pages, referenced chats, research sources**: named, never their content.
- **Left out**: the model's reasoning, the turn context (memories, time), answers that
  failed or are still being written. A message is cut at 6,000 characters, a page at
  about 40,000.
- The result says which `seq` range it showed and how to go on (`after_seq=…`,
  `before_seq=…`).

### Untrusted

Everything from the chats (titles too) is wrapped in `<untrusted_data source="…">` with
`tools/untrusted.py`'s `untrusted()`; the hints on how to go on are outside the block.
An earlier chat holds what web pages and tools returned, pages attached by the browser
extension and text other people wrote, so it may carry instructions; the automation
system prompt already says never to follow anything inside such a block. A closing tag
inside a chat is broken up and can't end the block early (tested).

## Which chats an agent sees

`features/conversations/recall.py` `visible()`, used by both tools:

| Chat | Seen? | Why |
| --- | --- | --- |
| The chat the run is in (for a sub-agent: its parent's chat) | no | It has it already; `read_chat` says so. |
| Temporary chats | no | "Nothing is remembered from it" is their promise. |
| Deleted chats | no | Deleting a chat deletes its rows (and now its index chunks); there is no chat trash. |
| Automation run chats past keeping | no | The same rule as `automations/removal.py` (`nothing_to_do` after 7 days, otherwise after the automation's `chat_retention_days`). The pruner deletes them within half a minute anyway; between those moments they are already invisible. |
| Automation run chats still kept | yes | They are the record of what an automation found ("what did last week's check say?"). Marked "an automation run". |
| Archived chats | yes | Archiving tidies the sidebar and the chat list; it doesn't mean "forget this" (deleting does). Marked "archived". |
| Chats in another project | only with `scope: "all"` | Same rule as documents: a project chat keeps to its project unless the request needs more. |

Projects are a way to look at data, not a wall (features.md), so `read_chat` with an
explicit id reads a chat of another project; the search is what keeps to the scope.

## Finding chats by meaning: what is indexed, and why

**Decision: one chunk per message, not conversation summaries.**

- *Summaries* would need a call to the summarization model per chat (and again whenever
  it grows): slow, costly, and lossy in exactly the details recall is for (a number, a
  name, a decision). They would also not say *where* in the chat something was, so
  `read_chat` couldn't jump there.
- *Messages*: embedding is cheap (a few cents per million tokens with
  `text-embedding-3-small`, free with a local model), and a hit points at one message
  (`chunk_index` = its `seq`), which `read_chat(around_seq=…)` opens.

Details:

- `source_type = "chat"`, `source_id` = the conversation, `chunk_index` = the message's
  seq, `content` = the first 2,000 characters of its text (`text_plain`: no tool
  results, no attached pages, no reasoning). User and shown assistant messages only.
- **Only ordinary chats**: never temporary chats, and not automation run chats (an
  automation that runs every 15 minutes would make most of the index and most of the
  cost; their words are still found).
- **Only with an embedding model**: without one nothing is written (the messages' own
  `tsv` already finds the words, so keyword-only chunks would just duplicate them).
- **When**: the scheduler's `chats.index` task (every 30 s) claims up to 10 chats that
  have been quiet for 2 minutes and have messages newer than their last indexing (or
  were indexed with another embedding model), and queues one `chats.index` background
  job per chat (`jobs/runner.py`; a dedupe key per claim) in the same transaction. The
  scheduler never calls the embedding model itself, so a slow provider doesn't hold up
  reminders and automations. Two new columns on `conversations` (migration `0083`):
  `recall_indexed_at` (the chat's `last_message_at` when it was indexed) and
  `recall_index_model`. A chat is claimed by setting these, with `SKIP LOCKED`, so no row
  stays locked while the embedding model is called, and two workers never take the same
  chat. A chat deleted before its job runs is left alone.
- **Only new text is embedded**: `knowledge/index.py` `index_source` now keeps the
  vector of a chunk whose text (hash) is unchanged and was made by the current model.
  A chat that gets one more message costs one embedding, not the whole chat again. This
  also makes re-indexing a changed document cheaper.
- **Existing chats**: after an embedding model is set (or changed), the task works
  through all chats, newest first, 10 per half minute (about 1,200 an hour).
- **Deleting** a chat removes its chunks (`delete_conversations`). The downgrade of
  `0083` removes all chat chunks.
- If embedding fails (`index_source` reports whether every chunk got its vector), the job
  saves nothing and fails, so the queue retries it (3 attempts, with backoff); after the
  last one a give-up hook drops the chat's claim and the scheduler takes it again. A
  backfill during a provider outage therefore catches up once the provider is back
  (meanwhile the chat is found by its words, and the same few chats are retried each
  pass). Documents and memories are indexed as before: on failure their chunks are
  stored without vectors.

**Privacy**: with an embedding model set, the text of your chats goes to the embedding
provider, as your documents and memories already do. Chat text already goes to the chat
model's provider; with a local embedding model (Ollama) it stays on your machine.

## Permission

`chats.read`, "Read earlier chats", default `autonomous`; both tools return one `safe`
action (`resource` `chats:project|all` or `chat:<id>`), so every level behaves as its
name says. It is a `*.read` capability: the calls count as changing nothing (an
automation run that only searched chats still "did nothing").

Automations: `tools/registry.py` `allowed()` has a `NAMED_ONLY` set (the two chat
tools); with `unattended=True` and no tool list they are dropped. The runtime passes
`unattended` (one line in `runtime/agent.py`, where the list is applied). A script or a
change check names its tools explicitly, so it may use them like any other read tool.
They are not in `FEATURE_TOOLS`: no page owns chats, so turning pages off never removes
them.

## Code

| Where | What |
| --- | --- |
| `features/conversations/search.py` | `matching_messages()`: the message full-text query, shared with the chat list and the search page |
| `features/conversations/recall.py` | `visible()`, scope helpers, `search()`, `page()`, `index_chat()`, `index_due()`, `forget()` |
| `tools/builtin/chats.py` | `SearchChats`, `ReadChat`, `render_message()` |
| `knowledge/index.py` | `index_source(positions=…)`, vector reuse, `Hit.chunk_index` |
| `policy/presets.py`, `tools/registry.py`, `jobs/scheduler.py`, `jobs/runner.py` | the category, the tools and `NAMED_ONLY`, the `chats.index` task (claims) and job (embeds; its give-up hook drops the claim) |
| `frontend/src/locales/{uk,ru}/chatRecall.ts` | the category's label and description |

Tests: `tests/api/test_chat_recall.py` (an agent turn with the scripted model; scope;
title and archived; exclusions incl. retention; paging; text-only rendering; the
untrusted block; the permission; indexing, meaning-only hits with the fake embedding,
re-embedding only new text, deletion, the scheduler only claiming and a job per chat
embedding, a failed embedding retried and recovered, documents still indexed by their
words when embedding fails), `tests/unit/test_chat_recall_tools.py`
(category, actions, offering incl. automations, inputs, message rendering),
`frontend/src/features/agents/PermissionsPage.test.tsx`.

No e2e spec: the e2e stack's fake model can only run its fixed `agent` demo (the
`scripted` model is filled in-process by the backend tests), so an e2e flow would first
need a new trigger in the shared fake provider. The API test runs the same turn through
the real runtime.

## Limits and what's left

- Not offered in Chat mode. Recall would be useful there too; it would need adding the
  tools to `CHAT_MODE_TOOLS` and the untrusted hint in the chat-mode prompt. Left for a
  decision.
- No nicer rendering in the run timeline: the call shows its summary and the result text
  (titles and ids). Links to the chats found (`data.chats`) would be a small addition to
  `RunActivity.tsx`.
- Long messages are embedded by their first 2,000 characters only.
- The keyword part looks at the 200 best-matching messages in the scope (as the search
  page does without one); in a very large history it could miss chats beyond those.
- The search page and Ctrl+K still list temporary and automation chats as before; that
  is their behaviour, unchanged here.
- `automations/removal.py` and `recall.py` both spell out the "past keeping" rule; the
  removal module can't be imported by tools (it imports the conversations service).
  Moving the rule into one place is a follow-up for the automations owner.
