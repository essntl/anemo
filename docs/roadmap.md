# Roadmap

Where Anemo stands, what is being built now, and what comes next. Each item links to
its spec or to the section of [features.md](features.md) that says how it works.

Last audited against the code and the git history on **2026-11-24** (`main` at
`0c5b488`, pull request #75).

- [Done](#done): built and merged into `main`.
- [In progress](#in-progress): this round's four pull requests.
- [Next](#next): agreed or proposed, with what already exists of each.
- [Ideas](#ideas): worth keeping, not planned.

Every pull request: backend and frontend tests, an end-to-end test with the fake
provider where the area has them, the checks of `make test` and `make lint`, `make
gen-api` after an API change, `docs/features.md` updated, and this file updated.

---

## Done

### The workspace (before the specs)

| What | Where it is described | Pull requests |
| --- | --- | --- |
| Chat and Agent mode, tools, permissions and approvals, plans, sub-agents, skills as slash commands | [features.md](features.md#chat-vs-agent-mode) | #7, #9, #10 |
| Claude subscription as a model provider (Claude Code in `claude-runner`) | [claude-code.md](claude-code.md) | #1, #44, #45, #66 |
| Home, focus timer, music, Dynamic Island, stats | [features.md](features.md#home) | #4, #48 |
| Files in chats, Office files, uploads of many files and folders | [features.md](features.md#files-in-chats) | #11, #54 |
| Shortcut sheet (**?**) with one registry for every shortcut | [features.md](features.md#keyboard-shortcuts) | #14 |
| Daily note widget on Home | [features.md](features.md#home) | #15 |
| Subtasks, checklists and *blocked by* links | [features.md](features.md#tasks-and-calendar) | #12 |
| Push notifications, with Allow once / Deny on approvals | [features.md](features.md#notifications) | #13 |
| First-run setup and the update notice | [features.md](features.md) | #18 |
| Diagrams, charts and math | [features.md](features.md#diagrams-charts-and-math) | #16 |
| The refactor: conventions, import boundaries, run lifecycle, agent loop split | `refactor/` | #21–#31 |
| Redesigned shell: sidebar, top bar, **Inbox** (notifications and *Needs you*), project switcher | [features.md](features.md#notifications) | #42, #43, #46, #47 |
| Ukrainian and Russian; Settings → Pages to arrange and turn off pages | [features.md](features.md) | #49 |
| Reasoning effort slider | [features.md](features.md#reasoning-effort) | #57 |
| Prebuilt images for x86-64 and ARM64 | [deployment.md](deployment.md) | #3, #52, #55 |

### Anemo Companion (the browser extension)

Built: a Chromium extension with a side panel chat, "Share this tab", the agent's
browser tools in your own Chrome (every click asks), YouTube transcripts, attachments,
find in chat. `extension/`, [companion-contracts.md](companion-contracts.md),
[features.md](features.md#browser-extension). Pull requests #37–#40.

### Specs 01–04 (the "fundamentals" round, `integrate/fundamentals`, #58)

| Spec | Status |
| --- | --- |
| [01 Organisation, links and sources](specs/01-organisation-links-sources.md), phases 1–3 | **Done.** Who created and last changed a document, task or event (`app/core/actor.py`, `features/provenance/`); source fields and `external_key` for synced items; document properties, views and stable paths; links and backlinks between documents, tasks and events. Known small gaps: [FINAL-REPORT.md](specs/FINAL-REPORT.md) §5. |
| [02 Automations that reason](specs/02-automations.md) | **Done.** Quiet runs (`agent_decides`), the state note, model, tool allowlist and limits per automation, contact tools always ask, no overlapping runs, approvals that don't block later runs, the change check, the failure streak. The real artemk automation is set up by hand (FINAL-REPORT.md §4). Webhooks (§2.8) were left for later on purpose. |
| [03 Response timer](specs/03-response-timer.md) | **Done.** Durations on messages, runs and tool calls. |
| [04 Dictation](specs/04-dictation.md) | **Done** (#59, #60). Speak and get tidy text where you were typing; WAV upload so whisper.cpp servers take it. |

### Devices (specs 05 and 06, `integrate/devices`, #62)

| What | Status |
| --- | --- |
| [05 Anemo Voice](specs/05-voice-android.md) (Android, `android/`) | **Done, and used on a real phone** (#62, #63). Wake word only (no button); one wake word = one answered turn; questions, approvals and plan reviews by voice; a follow-up within 5 minutes continues the same chat (the phone sends the chat's id: the *microphone* does not reopen by itself). A model of its own for voice requests. |
| [06 Anemo Desktop](specs/06-desktop-client.md) (Windows, `desktop/`) | **Done.** Tray client in C# / .NET 8: look and act (UI Automation, `SendInput`), PowerShell on a trusted computer, shared screen, stop hotkey, watched / trusted levels. Its manual test list (`desktop/MANUAL-TESTS.md`) is still open on real hardware. |
| Release workflow for both apps, redesigned screens and icons | **Done** (#69, #70). |

### Code sessions (the Code page)

**Done** ([code-sessions.md](specs/code-sessions.md), #67, #68, #72, #73, #75). Anemo
Desktop shares the Claude Code jobs that run on a trusted Windows computer (the
`C:\anemo-bridge\jobs` folder format of `cc.ps1`: `out.jsonl` in stream-json): a live
view on the Code page, starting a job in a project (cloned from GitHub if needed),
follow-ups, cancelling, queued messages, and the agent tools `code_projects`,
`code_start`, `code_status`, `code_cancel`. Works on a phone (#75).

---

## In progress

This round (2026-11-24). One branch and pull request each, all from `main`; shared
names are in [specs/CONTRACTS-round3.md](specs/CONTRACTS-round3.md), the round's log in
[specs/ORCHESTRATION-LOG-round3.md](specs/ORCHESTRATION-LOG-round3.md).

| Branch | What | Spec |
| --- | --- | --- |
| `feat/roadmap-refresh` | This file, audited against the code; the round's contracts and log. | – |
| `feat/voice-mode-android` | Anemo Voice: a cue the moment the wake word is heard (sound and vibration on a stream that doesn't follow media volume, media ducked, the audio from the wake word on kept), distinct start / end / timeout sounds; a **voice mode** for continuous conversation, turned on only by you (tile, notification, the phrase "start voice mode" matched on the phone) and off by tile, "stop", an idle timeout or the new agent tool `voice_stop`. | `specs/07-voice-mode-android.md` |
| `feat/automation-scripts` | **Scripts** as a kind of automation: code that runs without a model, acts only through Anemo's tools (approvals apply), can hand off to the model with `anemo.think`, and starts disabled until you have read the code or the diff. A Scripts tab in Automations. | `specs/08-automation-scripts.md` |
| `feat/desktop-macos` | Anemo Desktop for macOS (Apple Silicon first): Code jobs, look and act, shell, shared screen; the device's shell type known to the server instead of assuming PowerShell. Can't be run on this Windows VM: a manual test list for a real Mac. | `specs/09-desktop-macos.md`, `specs/09-desktop-macos-mac-testing.md` |

---

## Next

Proposals that are still open, with what of each exists today. Order is a suggestion.

### Activity log with undo

**Status: not built as such; the pieces exist.** There is no single list of "what was
done, by whom, and undo it". What exists:

- `audit_log` (`features/audit/`): security-relevant actions only (logins, settings,
  tokens, devices, MCP servers, approvals by voice), actor `user | agent | system`.
- Provenance on documents, tasks and events: who created them and who changed them last
  (`created_by` / `updated_by` as actor references `user`, `chat:<id>`,
  `automation:<id>/<run>`), shown as "the assistant in ‹chat›".
- Per run: the timeline of tool calls; for automation runs, the list of changes the
  server recorded (`runs.changes`, at most 200, `{tool, summary, ref}`).
- **Undo** exists for files an agent changed (each change is kept and can be reverted
  while the file is still as the agent left it: `workspace/revert.py`), for deletions
  (the trash), and for a memory just saved (a notice with *Undo*). Task, event and
  document edits can't be undone from one place (documents have revisions).

What it would take: one `activity` table written where `record_change` and the
provenance helpers already run, a page that lists it with filters (by actor, by
object), and undo per entry where an inverse exists (file revert, trash restore, a
task/event field change from a stored before-value). This round's scripts
(`feat/automation-scripts`) record their actions with provenance through the same
paths, so they show up there once it exists.

### Inbox for loose items

**Status: partly built.** The **Inbox** page exists (notifications, and *Needs you*:
approvals, memory suggestions, the update notice). What is not built: a capture inbox
for loose items (a thought, a link, a file) to sort into tasks, documents or projects
later.

### Project-scoped memories

**Status: not built.** Memories are global (`memories` has a `project` *kind* but no
project id); projects have their own instructions instead. Needs a nullable
`project_id` on memories, retrieval that prefers the current project's, and a filter on
the Memory page.

### Chat recall

**Status: partly built.** Chats are found by the search page and Ctrl+K (full text in
messages and titles). Agents have no tool to search or read earlier chats; memories
extracted from chats are the only bridge. Next step: a read-only `search_chats` /
`read_chat` tool pair under a new permission.

### Ctrl+K

**Status: done.** The command palette searches chats, documents, memories, tasks,
events, files and automations, and page names (features.md, *Search*). Left: actions
in the palette (new task, start focus, …) beyond opening pages.

### Templates

**Status: partly built.** Automations have *Start from a template* (e.g. *Daily
summary*); skills act as reusable prompts (slash commands). Not built: templates for
documents, tasks or projects.

### Devices, from the specs' "Later"

- Files between Anemo's workspace and a device (`device_file_get` / `device_file_put`).
- A Linux client on the same protocol (macOS is in progress).
- Watching a window over time (with your say-so) for longer tasks on the VM.
- Run the Windows client's manual tests on real hardware; `Windows.Graphics.Capture` has
  never run (GDI is the fallback in use).

### Voice, from the spec's "Later"

- Voice notes without a run: "note: …" straight into the daily note.
- A realtime voice model for real back-and-forth (the phone would get a short-lived
  key; tools "start a run" and "check a run").

### Automations

- Webhooks (`POST /api/hooks/{id}` with an HMAC signature, behind a Cloudflare Tunnel
  rule), spec 02 §2.8. Scripts (in progress) are designed not to rule it out.

---

## Ideas

- A Wear OS tile as a push-to-talk button.
- Inline links in single changed occurrences of repeating events; search-box chips for
  more than documents; an "in the trash" state for links to documents and chats
  (FINAL-REPORT.md §5).
- Agent moves of documents offering instruction and memory updates inline instead of
  through the Inbox.
- The licence question for the Android app: the repo is GPL v2, the APK links
  Apache-2.0 libraries (only matters when the APK is distributed).
