# Long chats: old tool results, `/compact` and auto-compact

Efficiency round 2, items 2 and 2b (November 2026). Written before the code, then kept up to
date with it.

## 1. Old tool results (item 2): what the history really holds

The plan was: when a new user message starts a turn, replace tool results that are older
than N user turns and longer than M characters with a short stub, persisted, so every later
request shares the new prefix.

Reading the runtime first showed that, **for the API providers, a chat's history holds no
tool results at all**:

- `agent_finalize.finalize` writes an answer's chat message as its reasoning and its final
  text, nothing else. The tool calls and their results stay in the run's own transcript
  (`runs.transcript`) and in `tool_calls`; the chat shows them from there.
- `runtime/history.py::load_history` builds the next turn's input from the chat messages,
  so turn N+1 sees the user messages and the answers' text of turns 1..N. A file read or a
  job report from turn 3 is not in turn 10's requests.

So tool results only pile up in two places, and neither is where the plan put the cut:

1. **Inside one run** (a long agent task): every step re-reads the run's transcript. The
   plan rules this out on purpose ("never within a tool loop": each cut would rewrite the
   cache on every step). A run already compacts itself when its transcript passes 75 % of the
   model's budget (`runtime/compaction.py`); §4.5 lowers that point to the auto-compact
   setting.
2. **Claude Code runner chats**: the CLI's session keeps every tool result (Anemo's tools
   reach it through the MCP bridge), and Claude Code decides when to compact. Anemo cannot
   rewrite that session without editing Claude Code's own files. §5 hands the CLI the same
   threshold instead.

**Decision: no tool-result trimming is built.** It would have nothing to act on. The
measurement in §6 shows a simulated long API chat: its first request per turn grows only by
the user's messages and the answers' text.

## 2. `/compact [focus]` (item 2b)

The user types `/compact` (optionally followed by what to keep in detail, the *focus*) in
the composer of a chat on an API provider (anything but the Claude subscription). Enter
sends no message: it asks the chat's model for a structured summary of the conversation so
far, and from then on the model gets that summary plus the last few turns instead of the
whole chat.

- The chat keeps every message as it was. Where it was compacted, a divider says
  *Compacted here (312k → 14k tokens)*; it opens to show the summary. `search_chats` and
  `read_chat` still find and read the original messages (they are untouched rows).
- A chat on the Claude subscription answers `/compact` with *Claude Code compacts this chat
  by itself* (409 `compacts_itself`), and is never auto-compacted by Anemo.
- While a run is going, `/compact` is refused like any other message (409, as `send_turn`).

### The summary

The chat's own model writes it, in a request that is the chat's next request would be: the
same system prompt, the same tools (agent mode) and the same history, then one more user
message with the instruction below. That request reads the conversation from the prompt
cache, so a 250k-token chat costs a cached read plus the summary's output, not 250k fresh
tokens. Tool calls in the answer are ignored (the tools are only declared so the prefix stays
the same).

```
Write a summary of our conversation so far. It replaces the conversation in your context:
from now on you see only this summary and the last few messages, so keep everything you
will need to continue correctly. Use these headings:

## Goal and context      what the user wants, constraints, preferences
## Decisions             what was decided, and why (one line each)
## Current state         what is done, what exists now (files, documents, tasks, code)
## Open tasks            what is left, in order; open questions for the user
## Identifiers           exact paths, URLs, PR numbers, job ids, task/event ids, names
## Numbers               figures, dates, amounts and results that still matter

Be complete but terse: bullet points, no greetings, nothing invented. Write in the
language of the conversation.
[Keep these in full detail: <focus>]
```

### What the model gets afterwards

A compaction is a chat row (`messages.role = 'compaction'`) whose text is the summary and
whose `compaction` column (JSONB, migration 0088) holds:

| key | meaning |
| --- | --- |
| `kept_from_seq` | the first message kept verbatim (a user message), or the row's own seq |
| `tokens_before` / `tokens_after` | the estimated context before and after (for the divider) |
| `focus` | what the user asked to keep, or null |
| `auto` | started by the threshold, not by `/compact` |

`load_history(before_seq)` uses the newest *complete* compaction row before `before_seq`:
the model input is one user message `[Summary of the earlier conversation …]` + summary,
then the messages from `kept_from_seq` on (compaction rows themselves never), merged as
usual where roles repeat. An older compaction is replaced by a newer one (the newer summary
was written from a history that had the older one). A failed or unfinished compaction row
is skipped, so the chat goes on as before.

The last turns kept verbatim: up to 2 user turns (with their answers) before the compaction
point, while they stay under 20 % of the context before it; fewer when they are big (a
pasted document), none when even the last one is.

The cache: the first request after a compaction starts a new prefix (one cache write); every
request after it reads that prefix again. At most one rewrite per compaction.

## 3. Auto-compact

A new settings section `chat` (`ChatSettings`):

| field | default | range |
| --- | --- | --- |
| `auto_compact` | true | |
| `compact_at_tokens` | 250 000 | 20 000 – 2 000 000 |

Only at the start of a user turn (`send_turn`, not in a tool loop, not for regenerate or
edit-last): when the estimated context of the chat (§4.2) is at or above
`compact_at_tokens`, `send_turn` adds a compaction row (`auto: true`) *before* the new user
message, and the turn's run compacts first, then answers from the compacted history. The
turn's own events say `chat.compacted` when the summary is in, so the chat shows the
divider; the summary's text is not streamed into the answer.

If the summary fails (the provider errors, the answer is empty), the row ends as `error`
and the turn is answered from the full history, as without auto-compact.

The composer warns shortly before: at 85 % of the threshold a line under it says
*This chat is at 214k of 250k tokens: it will be compacted when it passes 250k (/compact
does it now).* At or above it: *This chat will be compacted before your next message.*
Not shown for chats on the Claude subscription, or with auto-compact off (then only the
size is shown, from 85 %).

## 4. Pieces

1. `features/conversations/compaction.py` (API and worker): the estimate, the newest
   compaction, which turns are kept, creating the row. No model calls.
2. **The estimate** (`context_tokens`): characters / 4 of the messages the model would get
   (from the newest compaction's `kept_from_seq`, plus that summary; else all), counted in
   SQL (`octet_length(content::text) + length(turn_context)`), images as their stored JSON.
   Good enough for a threshold; the divider shows the same estimate before and after.
3. `GET /conversations/{id}/context` → `{tokens, compact_at, auto_compact, compacts_itself}`;
   `POST /conversations/{id}/compact {focus?}` → `{run_id, message}` (202).
4. `runtime/chat_compaction.py` (worker): the instruction, one model call through
   `stream_with_fallback` with the caller's request builder, saving the summary and the
   numbers into the row. Used by the agent loop (`agent.py`) and the plain chat path
   (`chat.py`): a `/compact` run (`run.options.compact`) does only that; a turn run with
   `run.options.compact_first` does it before its answer.
5. In-run compaction (`agent.py::_maybe_compact`, sub-agents and automations included)
   starts at `min(75 % of the budget, compact_at_tokens)` instead of 75 % only, so a run on a
   1M-token model doesn't carry 700k tokens before it summarizes. Its own summary prompt stays.
6. Frontend: the divider (`CompactionDivider`), the composer's `/compact` (sent on Enter,
   never as a message; the slash menu entry comes with item 2c), the warning, and the two
   settings in Settings > Chat behaviour.

## 5. Claude Code runner chats

- `/compact` doesn't reach Claude Code: the runner starts the CLI with
  `--disable-slash-commands` on purpose (a `/…` in a message is text, skills are off), and
  Anemo's session ledger (`providers/adapters/claude_code.py`) would have to learn what a
  compacted session holds. Not cheap: skipped.
- Claude Code 2.1 has an auto-compact window (the `autoCompactWindow` setting,
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW`): it compacts when the conversation nears that many
  tokens. The runner passes `compact_at_tokens` as `autoCompactWindow` in the settings JSON
  it already gives every process, so one setting means about the same on both kinds of
  provider. `auto_compact: false` doesn't turn Claude Code's compaction off (a session that
  outgrows the context would fail).

## 6. Measurements

See the PR: a simulated chat of 60 turns (fake provider), first request per turn, with and
without auto-compact at 50k tokens.
