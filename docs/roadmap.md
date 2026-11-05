# Roadmap

Features agreed on but not built yet. Each one says what it does for you and roughly
how it fits into what Anemo already has; [Build order](#build-order) says in which
order they are built.

| # | Feature | Size | Wave |
| --- | --- | --- | --- |
| 1 | [Shortcut sheet](#1-shortcut-sheet) | small | 2 |
| 2 | [Daily note widget](#2-daily-note-widget) | small–medium | 2 |
| 3 | [Subtasks, checklists and *blocked by* links](#3-subtasks-checklists-and-blocked-by-links) | medium | 1 |
| 4 | [Real push notifications](#4-real-push-notifications) | medium | 1 |
| 5 | [First-run setup and update notice](#5-first-run-setup-and-update-notice) | medium | 3 |
| 6 | [Diagrams, charts and math](#6-diagrams-charts-and-math) | medium | 2 |

## Build order

One feature per branch and pull request, each started from the latest `main`. The
features in a wave don't depend on each other and can be built at the same time; a
wave starts once everything before it is merged.

| Wave | Features | Why this order |
| --- | --- | --- |
| 1 | **3** Subtasks, checklists and *blocked by* · **4** Push notifications | The two largest backend changes, in separate parts of the code. Each adds a migration: whichever merges second rebases onto the first and points its migration at it. |
| 2 | **1** Shortcut sheet · **2** Daily note widget · **6** Diagrams, charts and math | Mostly frontend and small. The shortcut sheet changes the shared hotkey code, so nothing else in this wave adds shortcuts; the daily note doesn't touch the document editor that diagrams change. |
| 3 | **5** First-run setup and update notice | Last, because it uses the others: its notifications step turns on push (4), and it can point to the shortcut sheet (1) and the Home widgets (2). |

Every pull request: backend and frontend tests, an end-to-end test with the fake
provider, `make test`, `make lint` and `make gen-api` passing, the README section for
the feature written or updated, and the feature marked done here.

---

## 1. Shortcut sheet

**Status: built.**

Press **?** anywhere (outside a text field) to see every keyboard shortcut in one
place. Today they are spread over the README and individual pages (Ctrl+K, Ctrl+\\,
E on Home, Space/R/S/+ for the timer, Shift over the chat list, …) and nothing in
the app lists them.

- An overlay grouped by area: *Everywhere*, *Chat*, *Home*, *Focus*, *Files*, … with
  the page you are on shown first.
- Shows ⌘ instead of Ctrl on a Mac.
- Also reachable from the search box (Ctrl+K → *Keyboard shortcuts*) and from a small
  link in Settings.
- The shortcuts are registered in one list that the hotkey hook and the sheet both
  read, so the sheet can't fall out of date when a shortcut is added or changed.
- Not shown on touch-only devices.

## 2. Daily note widget

**Status: built.**

A **Daily note** widget on Home for today's important short notes: a phone number to
call back, a thought to pick up later, three things that must not slip today.

- Type a line and press Enter: it is added as a short note. Notes can be ticked off,
  edited, reordered and deleted in place; nothing to open or save.
- One note per day. The day follows the time zone from **Settings → General**, so it
  turns over at your midnight, not the server's.
- Arrows in the widget step back through earlier days (read and edit); *Today* jumps
  back.
- Optional (Settings → General): carry unticked notes over to the next day.
- Stored as an ordinary Markdown document, `documents/daily/<date>.md`, as a
  checklist. So the notes show up in search, keep a version history, can be linked
  to from tasks and documents, and agents can read them (and add to them under the
  *Edit documents* permission), for example from the **Daily summary** automation.
- Follows the project switcher like the other widgets: with a project chosen, the
  widget shows that project's daily note (`documents/<project>/daily/<date>.md`).
- Placed near the top of the default layout; existing layouts get it added and can
  hide it in **Edit layout**.

## 3. Subtasks, checklists and *blocked by* links

**Status: built.**

Three ways to break up and order work inside **Tasks**.

**Checklist.** Quick items inside one task (text and a tick), for steps that don't
need their own date or status.

- Added and ticked in the task editor; the list and the board show progress
  ("3/5") on the task.
- A repeating task's next occurrence gets the same checklist, unticked.

**Subtasks.** Real tasks that belong to a parent task: their own status, due date,
priority, notes and attachments.

- Shown under the parent in the task editor and, folded, in the list. One level deep,
  to keep it simple.
- Finishing a parent with open subtasks asks whether to finish them too.
- The parent's project and tags are suggested for new subtasks.

**Blocked by.** A task can wait on one or more other tasks.

- Pick them in the task's side panel. The other task shows *Blocks: …* in turn.
- While any of them is open the task is marked as blocked (a badge in the list and on
  the board). When the last one is done, its status moves from *blocked* back to *to
  do* and you get a notification.
- Loops (A waits on B, B waits on A) are refused.
- Deleting a task removes it from what it blocked.

**Everywhere else:** agents can read and change all three with the *Manage tasks*
permission; shared projects show them in the copy; search finds checklist items.

## 4. Real push notifications

**Status: built.**

Notifications on your phone or computer **even when Anemo is closed**, without
Discord. Uses the browser's standard Web Push, which works in Chrome, Edge and
Firefox, and on iPhone/iPad (iOS 16.4+) once Anemo is added to the Home Screen.

- **Settings → Notifications → Push**: *Turn on for this device*. Each device you turn
  it on for is listed with its name and when it last received something, and can be
  removed. As with Discord, you pick which kinds go to push (reminders, automations,
  approvals, agent messages, focus).
- Tapping a notification opens the page it is about (the chat, the task, the run).
- **Approve from the notification.** When an agent or automation is waiting for
  approval, the notification has **Allow once** and **Deny** buttons. Each button
  works one time, only for that approval, and expires with it; anything else (e.g.
  *Allow for this run*) opens the approval in the app.
- Built on the existing notification outbox: push is a new kind of destination next
  to Discord, so sending is retried the same way, and a device that has been removed
  or no longer accepts pushes is dropped on its own.
- The server's push keys (VAPID) are created on first start and stored encrypted.
- Needs HTTPS, like desktop notifications. A notification shows only its title and a
  short line, never file contents or secrets.

## 5. First-run setup and update notice

**First-run setup.** On the first login, a short guided setup instead of an empty app
and a hint to go to Settings.

1. **Model provider**: add one (OpenAI, Anthropic, OpenRouter, an OpenAI-compatible
   server such as Ollama, or the Claude subscription), test it, pick models and the
   default chat model.
2. **Helper models** (optional): Summaries, Memory and Embeddings, with sensible
   suggestions from the provider just added.
3. **You**: time zone, and whether Anemo opens on Home or a new chat.
4. **Optional parts**: a check of the sandbox, browser, MCP host, Claude runner and
   SearXNG. Each one shows whether it is running and, if not, the one command or
   `.env` line that starts it.
5. **Notifications** (optional): turn on push for this device or add Discord.

Every step can be skipped, the setup can be left and picked up later, and it can be
opened again from **Settings → Advanced**. Nothing it sets differs from setting it by
hand.

**Update notice.** Tells you when a newer Anemo is out, and what changed once you
have updated.

- About once a day the server compares its version with the latest release on GitHub.
  When a newer one exists, **Settings → Advanced** shows it with its release notes and
  the update command for your setup (`docker compose pull && docker compose up -d`),
  and a small dismissible notice appears once.
- After an update, a **What's new** card shows that version's notes once.
- Anemo never updates itself. The check is the only call it makes for this, sends
  nothing about you, and can be switched off in Settings → Advanced (or with an `.env`
  setting).

## 6. Diagrams, charts and math

**Status: built.**

Answers, documents and automation results can show **diagrams, charts and formulas**
instead of their source code. Today a diagram the model writes appears as a plain code
block.

They are ordinary fenced code blocks in Markdown, so files stay plain Markdown, other
Markdown tools still read them, and agents need no new tool to make them:

- **```` ```mermaid ````**: flowcharts, mind maps, sequence diagrams, timelines, Gantt
  charts, state diagrams and pie charts ([Mermaid](https://mermaid.js.org/)).
- **```` ```chart ````**: line, bar, area and pie charts from a small JSON description
  (`type`, the x values, one or more named series). Drawn by Anemo itself, so charts
  use the app's colors, work in light and dark mode, and show values on hover.
- **Math**: `$…$` inline and `$$…$$` as a block (KaTeX).

**How it behaves**

- The same rendering everywhere: chat, documents, share links, automation results and
  run pages.
- While an answer is still being written the block shows its code; it is drawn once
  the block is complete, so nothing flickers or errors halfway.
- Each diagram or chart has: *Source / Diagram* toggle, copy, download as SVG or PNG,
  and full screen with zoom and pan (for big mind maps).
- If the code can't be drawn, the source is shown with the error and a **Fix diagram**
  button that asks the model to correct it.
- In the document editor a diagram is shown drawn, with an edit button that opens its
  source; the Markdown source view shows the code as usual.
- Mermaid is only downloaded when a page actually contains a diagram, so pages
  without one stay as fast as now.

**Getting the model to use it**

- The system prompt (Chat and Agent mode) says these blocks are available and when they
  help, briefly.
- A built-in **`/diagram`** skill: "show this as a mind map / flowchart / timeline /
  chart". Like the other built-in skills it can be edited or switched off in
  **Settings → Skills**.
- Agents can turn data into charts directly, for example read a CSV with a shell
  command and answer with a `chart` block.

**Safety**

Diagrams can be written from untrusted content (a web page the agent read), so Mermaid
runs in its strict mode: no HTML or scripts in labels, no links that run code, and
nothing loaded from other sites. Charts are drawn from data only.
