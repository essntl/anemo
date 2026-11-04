# Roadmap

Features agreed on but not built yet, in the order they are planned. Each one says
what it does for you and roughly how it fits into what Anemo already has.

| # | Feature | Size |
| --- | --- | --- |
| 1 | [Shortcut sheet](#1-shortcut-sheet) | small |
| 2 | [Daily note widget](#2-daily-note-widget) | small–medium |
| 3 | [Subtasks, checklists and *blocked by* links](#3-subtasks-checklists-and-blocked-by-links) | medium |
| 4 | [Real push notifications](#4-real-push-notifications) | medium |
| 5 | [First-run setup and update notice](#5-first-run-setup-and-update-notice) | medium |

---

## 1. Shortcut sheet

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
