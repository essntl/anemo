# Roadmap

Where Anemo stands, what is being built now, and what comes next. Each item links to
its spec or to the section of [features.md](features.md) that says how it works.

Last audited against the code and the git history on **2026-11-24**, updated at
the end of round 3 (pull requests up to #82), and at the start of round 4 (2026-11-25).

- [Done](#done): built and merged into `main`.
- [In progress](#in-progress): open pull requests.
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

### Round 3 (2026-11-24)

Built in parallel from [specs/CONTRACTS-round3.md](specs/CONTRACTS-round3.md); how it
went is in [specs/ORCHESTRATION-LOG-round3.md](specs/ORCHESTRATION-LOG-round3.md).

| What | Spec | Pull request |
| --- | --- | --- |
| **Anemo Voice: a cue you can trust, and voice mode.** The start sound and a buzz play on the frame the wake word is detected, on the system-sounds stream (not media volume), with other audio ducked; the recording keeps the audio from the wake word on. Distinct start / end / timeout / reopen / on / off sounds. **Voice mode**: after each answer the mic reopens without a wake word, until you turn it off (tile, notification, "stop" on its own, 45 s of silence, or the agent's `voice_stop`). Only you turn it on (tile, notification, or "start voice mode", matched by code on the phone, never by the model). On/off goes to the audit log. Not yet tried on a phone. | [07](specs/07-voice-mode-android.md) | #78 |
| **Scripts under Automations.** A script is a kind of automation: TypeScript in a Deno sandbox (no network but declared hosts, its own folder only, time / memory / output limits, secrets by name) that acts only through Anemo's tools and approvals, hands judgement to the model with `anemo.think`, and runs only code you approved: anything an agent writes or changes waits, with a diff, in the Scripts tab. | [08](specs/08-automation-scripts.md) | #82 |
| **Anemo Desktop for macOS** (Apple Silicon): Code jobs, look and act (ScreenCaptureKit, Accessibility, CGEvent), shell, shared screen, permission screens, Keychain, open at login, menu bar. Devices now tell the server their system and shell (`platform`, `shell_kind`), and `bridge/cc.mjs` starts Claude Code jobs on Windows and macOS. Built and smoke-tested on CI's macOS runner; the full checklist needs a real Mac. Signing and notarization wait for an Apple Developer account. | [09](specs/09-desktop-macos.md), [Mac tests](specs/09-desktop-macos-mac-testing.md) | #81 |
| This roadmap, audited against the code. | – | #76 |

Merged alongside, from other sessions: the Code page's sub-agent sidebar and images in
prompts (#77), appearance and profile customisation (#79).

### Plugins (2026-11-25)

Designed as a public contract first ([specs/CONTRACTS-plugins.md](specs/CONTRACTS-plugins.md)),
then built in parallel; how it went is in
[specs/ORCHESTRATION-LOG-plugins.md](specs/ORCHESTRATION-LOG-plugins.md).

| What | Spec | Pull request |
| --- | --- | --- |
| **Plugins.** Packages with a manifest (stable id, semver, a hash per version) installed from a zip, a Git URL, the bundled examples or an assistant's chat; reviewed and approved per version with the password; UI in sealed iframes in four slots (panels on tasks/documents/events, pages, a plugin's settings, chat blocks), declarative contributions (properties, views, templates, automations, scripts, MCP servers, profiles, skills, themes, commands), every call checked as a tool call with the plugin as the actor; a kill switch. Settings → Plugins with cards that grow into the plugin's page; agent tools to build plugins in a chat. Examples: *Word count*, *Today board*, *Weekly review*. | [12](specs/12-plugins.md) | #87 |

### Round 4 (2026-11-25)

Built in parallel from [specs/CONTRACTS-round4.md](specs/CONTRACTS-round4.md); how it
went is in [specs/ORCHESTRATION-LOG-round4.md](specs/ORCHESTRATION-LOG-round4.md). Each
row is filled in by its own pull request.

| What | Spec | Pull request |
| --- | --- | --- |
| **Event triggers** (in progress) | [16](specs/16-event-triggers.md) | – |
| **MCP triggers** (in progress) | [17](specs/17-mcp-triggers.md) | – |
| **Chat recall.** Agent tools `search_chats` (by words and titles, by meaning with an embedding model; the chat's project by default, `"all"` on request) and `read_chat` (pages of messages by seq, text only) under the new permission *Read earlier chats*; never the run's own chat, temporary chats or run chats past keeping; results marked as untrusted; automations only when their tool list names them. | [18](specs/18-chat-recall.md) | #97 |
| **Activity log with undo** (in progress) | [19](specs/19-activity-log.md) | – |
| **Bulk task and event changes** (in progress) | [20](specs/20-bulk-changes.md) | – |
| **Waiting on a code job** (in progress) | [21](specs/21-code-wait.md) | – |
| **Files between devices and the workspace** (in progress) | [22](specs/22-device-files.md) | – |
| **Anemo Desktop updates itself** (in progress) | [23](specs/23-desktop-auto-update.md) | – |

---

## In progress

| Branch | What |
| --- | --- |
| `feat/image-generation` | A `generate_image` tool any chat model can call (#80, another session). |

To check by hand: Anemo Voice 1.1.0 on the phone (`android/MANUAL-TESTS.md`), Anemo
Desktop for macOS on a borrowed Mac (`docs/specs/09-desktop-macos-mac-testing.md`), the
Windows client's manual tests (`desktop/MANUAL-TESTS.md`).

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
task/event field change from a stored before-value). Scripts (#82)
record their actions with provenance through the same
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
- A Linux client on the same protocol (Windows and macOS exist).
- Watching a window over time (with your say-so) for longer tasks on the VM.
- Run the Windows client's manual tests on real hardware; `Windows.Graphics.Capture` has
  never run (GDI is the fallback in use).

### Voice, from the spec's "Later"

- Voice notes without a run: "note: …" straight into the daily note.
- A realtime voice model for real back-and-forth (the phone would get a short-lived
  key; tools "start a run" and "check a run").

### Plugins, after version 1

From spec 12 §8 and what building the examples showed:

- A marketplace: listing, signatures over the package hash, update checks.
- Optional (per-item) permissions; agent tools implemented by a plugin's script.
- Templates with placeholders (date, week) and a chosen folder and name.
- More slots: editor blocks in documents, Home widgets, the run timeline; plugin
  keyboard shortcuts; translations of plugin texts.
- An e2e spec for install → approve → panel (needs the Docker stack).

### Automations

- Webhooks (`POST /api/hooks/{id}` with an HMAC signature, behind a Cloudflare Tunnel
  rule), spec 02 §2.8. Scripts (#82) are designed not to rule it out.

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
