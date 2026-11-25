# Features

Everything Anemo does, one area at a time. The [README](../README.md) has the short
overview; setting it up is in [deployment.md](deployment.md), and how permissions and
sandboxes keep agents in check is in [security.md](security.md).

Not built yet: the OpenAI *Responses* API (OpenAI works through the chat completions
adapter), and searching inside workspace files that are not documents.

- [Chat vs. Agent mode](#chat-vs-agent-mode)
- [Projects and organising chats](#projects-and-organising-chats)
- [Files in chats](#files-in-chats)
- [Image generation](#image-generation)
- [Share links](#share-links)
- [Profiles, skills, plans and runs](#profiles-skills-plans-and-runs)
- [Skills as slash commands](#skills-as-slash-commands)
- [Diagrams, charts and math](#diagrams-charts-and-math)
- [Sub-agents](#sub-agents)
- [Documents](#documents)
- [Tasks and calendar](#tasks-and-calendar)
- [Appearance and profile](#appearance-and-profile)
- [Home](#home)
- [Focus](#focus)
- [Music](#music)
- [Dynamic Island](#dynamic-island)
- [Stats](#stats)
- [Notifications](#notifications)
- [Automations](#automations)
- [MCP servers](#mcp-servers)
- [Search](#search)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Usage](#usage)
- [Memory](#memory)
- [Web search and web pages](#web-search-and-web-pages)
- [Browser](#browser)
- [Your Claude subscription as a model](#your-claude-subscription-as-a-model)
- [Shell commands](#shell-commands)
- [Files](#files)
- [On your phone](#on-your-phone)
- [Browser extension](#browser-extension)
- [Voice from your phone](#voice-from-your-phone)
- [Devices: your computers (Windows and macOS)](#devices-your-computers-windows-and-macos)

## Chat vs. Agent mode

**Chat** answers directly and never uses tools. **Agent** may use tools (today:
planning; listing, reading, writing, editing, moving and deleting workspace
files; running shell commands), but every tool call is checked on
the server against **Settings → Agent Permissions**: per category you choose
*Never*, *Always ask*, *Ask for dangerous actions*, *Allowed in workspace* or
*Fully autonomous*. When an action needs approval the run pauses (no worker is held)
and an approval card appears in the chat: *Allow once*, *Allow for this run* (same
kind of action, same folder) or *Deny*. Paths outside the workspace and anything
touching settings or secrets are always refused, whatever the settings say.

## Reasoning effort

A model that can reason gets a **Reasoning** button next to it in the message box. It
opens a slider with five levels: *Off*, *Low*, *Medium* (the default), *High* and *Max*.
The level is kept as the default for every chat (`reasoning_effort` in Settings →
Models) and sent with each message, a new answer and an edit; automations and
sub-agents use the default. Each provider gets the nearest level it accepts:

| Level | Claude API (adaptive thinking) | Claude API (older, thinking budget) | OpenAI, OpenRouter | Claude subscription |
|---|---|---|---|---|
| Off | no `thinking`, effort `low` (the newest models always think a little) | no thinking | `low` | `low` |
| Low | effort `low` | 2,048 tokens | `low` | `low` |
| Medium | effort `medium` | 8,000 tokens | `medium` | `medium` |
| High | effort `high` | 16,000 tokens | `high` | `high` |
| Max | effort `max` | 32,000 tokens | `high` | `max` |

Other OpenAI-compatible servers (Ollama, vLLM, …) get no level, so the button is not
shown for their models. On the Claude subscription a new level starts its Claude Code
session again (resumed, so the next answer misses the prompt cache once).

## Projects and organising chats

A **project** keeps one piece of work together: its chats, tasks, calendar events,
documents and files. Pick one in the switcher at the top of the sidebar and every
screen narrows to it; **All projects** shows everything again.

- New chats, tasks and events are created in the chosen project. A project's files live
  in `projects/<name>/` and its documents in `documents/<name>/`; renaming a project
  keeps those folders, and deleting it leaves them (and its chats, tasks and events)
  in place, without a project.
- A project can have **instructions** for the assistant (added to every chat in it, in
  Chat and Agent mode) and a default model and agent profile.
- It is a way to look at your data, not a wall: what an agent may touch is still decided
  by Settings → Agent Permissions and the folder access under Settings → Workspace.

Chats can be filed in a project, given **tags**, marked as **favorites** and
**archived**. **All chats** lists every chat with search, filters, sorting, and actions
on several at once. In the sidebar the chats take the free room and scroll on
their own; the pages (Files, Tasks, Runs, …) are pinned in a grid under them. On a
desktop the whole sidebar can be folded to a strip of icons (the button next to the
name, or Ctrl+\), which leaves more room for the page.

A **temporary chat** (the switch on the new-chat page) is listed under *Temporary* in
the sidebar with the time it has left, and is deleted 5 minutes after its last message
(never while an answer is still being written). Nothing is remembered from it.
**Keep chat** turns it into an ordinary chat.

To clear out several chats quickly, hold **Shift** with the mouse over the chat list
in the sidebar: every chat gets a delete button that deletes it at once, without
asking.

In a chat you can:

- **reference another chat** (the button next to the paperclip): the assistant gets that
  chat as background, in full when it is short and as a summary when it is long. The
  summary is written once by the summarization model and reused;
- **edit** your last message and have it answered again;
- **branch** from any answer into a new chat that starts as a copy up to that point;
- **download** the chat as Markdown or **save it as a document** in the workspace;
- **share** it by link (below).

## Files in chats

**Attach any file** with the paperclip, by dropping it on the composer or by pasting it
(up to 10 per message, 25 MB each). A paste works anywhere on the chat page, not only in
the message box; a pasted screenshot is named "Pasted image" with the time. A message
can be just files: **Send** works without writing anything. What the assistant gets
depends on the file:

| File | What the model gets |
|---|---|
| Images (PNG, JPEG, GIF, WebP) | the image itself, for models that can see images |
| PDF | its text (no OCR for scanned pages) |
| Word (`.docx`) | paragraphs, headings and tables |
| Excel (`.xlsx`, `.xlsm`) | every sheet as CSV (the last calculated values; first 2,000 rows) |
| PowerPoint (`.pptx`) | the text and speaker notes of each slide |
| Zip | the list of files, and the text of small text files in it |
| Text, Markdown, code, CSV, JSON, ... | the text |
| Anything else (`.xls`, `.sqlite`, audio, ...) | its name, type and size only |

In **Agent mode** the agent can work on the file itself, not just read it:
`save_attachment` copies an attachment into the workspace (it needs *Create and edit
files*), where it can change it with Python in the shell, unpack a zip with
`extract_zip`, and so on.

**The agent can give you files**, of any kind: spreadsheets, PDFs, Word and PowerPoint
files, zip bundles, standalone scripts, charts. It creates them in the workspace (the
shell sandbox has pandas, openpyxl, XlsxWriter, python-docx, python-pptx, reportlab,
pypdf and matplotlib, and `zip`), packs several into one with `create_zip`, and hands
them over with `attach_file`: they appear as downloads under its answer (up to 100 MB
each, 20 per answer). An attached file is a copy of the workspace file as it was then.
Each version of a regenerated answer keeps its own files, and a branched chat gets a
copy of them.

## Image generation

Ask for a picture ("draw a lighthouse at dusk, as a watercolour") in Chat or Agent mode
and the assistant calls the `generate_image` tool. Any chat model can do this, because
it is ordinary tool calling: the picture itself is made by the **image model** you
choose, through its provider's API. The pictures appear under the answer (click one for
the full size; each has a download button and an **Open in Files** link), and in Agent
mode the activity list shows the call with its pictures and paths.

- **Where they go**: `files/generated/<date>/<words-from-the-prompt>.png`, or
  `projects/<project>/generated/<date>/…` in a project's chat; the assistant can also be
  told a folder or a file name. A name that is taken gets `-2`, `-3`, …. Next to each
  picture is a `<picture>.json` file with the prompt, the model, the size, the time and
  the chat it came from.
- **Changing a picture**: the assistant passes a saved picture back as an input image
  ("make the sky darker"). OpenAI and OpenRouter image models can do this; Google's
  OpenAI-compatible endpoint cannot (the tool says so).
- **Options the assistant can choose**: shape (1:1, 4:3, 3:2, 16:9 and their portrait
  versions), how many (up to the limit below), quality (low, medium, high) and resolution
  (1K, 2K, 4K where the provider has a choice), and another configured image model if you
  ask for one by name.

**Setting it up** (Settings → Providers & Models):

1. A provider with image models: **OpenAI** (`gpt-image-1.5`, `gpt-image-2`; `gpt-image-1`
   was shut down in October 2026), **OpenRouter** (its image models, e.g.
   `google/gemini-2.5-flash-image`; *Discover* lists them), **Google Gemini** (new provider
   type with a Google AI Studio key: `gemini-2.5-flash-image`,
   `gemini-3-pro-image-preview`; it also gives you Gemini chat models), or an
   OpenAI-compatible server with `/images/generations`. Image models are recognised by
   name and marked **Image generation**; the switch is in each model's capabilities.
2. **Default models → Image generation**: the model to use. It never falls back to the
   chat model; without one, the assistant tells you to set it.
3. The **Image generation** card: pictures per request (default 4, at most 10), the largest
   resolution (default 2K), and whether automations ask first (default on). Changing it
   asks for your password again, like the permissions.

**Cost and permission**: every picture costs money at the provider, and each call is in
Usage (the provider's own cost for OpenRouter, an estimate from the model's prices for
OpenAI). The permission **Generate images** (Settings → Agent Permissions) is *Fully
autonomous* by default, so a chat makes pictures without asking; *Always ask* makes the
agent ask each time (in Chat mode, which cannot ask, the tool is then not offered), and
*Never* takes the tool away. Automations ask before each picture unless you switch that
off. A provider's refusal (content policy), a wrong key or no credit comes back as a
message in the chat, not an error page. The design is in
[specs/10-image-generation.md](specs/10-image-generation.md).

## Share links

Anemo is for one person, but you can let someone read a single chat, document or
project: **Share** in its menu creates a link that works without logging in.

- The link shows a **copy made at that moment**. It does not follow later changes
  unless you press **Update copy**, and it never includes attached files, the model's
  reasoning or agent activity.
- A shared **project** shows what you tick: its tasks with their notes, checklists and
  subtasks, its upcoming events, and its documents, which the visitor can open and read in full. Links
  between its tasks and documents work inside the copy; links to anything that is
  not part of it are shown as plain text. Its chats, files and instructions are
  never part of a link.
- A visitor can read, nothing else. No model, agent or tool is reachable from a link.
- Links expire (7 days by default) and can be revoked at any time. **Settings →
  Shared links** lists them all.
- A link only works for people who can reach your server.

Details in [docs/security.md](security.md#share-links).

## Dictation

Speak instead of typing: press **Caps Lock twice** anywhere in the app (also while you
type), or the microphone in the message box. Press Caps Lock twice again to finish, Esc
to cancel. What you said is transcribed, then tidied by a chat model: "um"s, false starts
and repeats go, corrections you make while speaking are applied, and a request with
several parts becomes a list. The text lands where you were typing.

- It needs a speech-to-text model: choose one for **Transcription** in Settings →
  Providers & Models (OpenAI's `gpt-4o-transcribe` or `whisper-1`, or a Whisper model on
  an OpenAI-compatible server such as Groq or your own). **Dictation clean-up** picks the
  model that tidies the text (unset: the chat model).
- **Settings → Dictation**: tidy-up on or off, the Caps Lock shortcut, the language, and
  words to spell right (names, projects, terms).
- Browsers give a page the microphone only over https (or on localhost).
- Neither the recording nor the text is kept; only a usage record.

Design: [docs/specs/04-dictation.md](specs/04-dictation.md).

## Profiles, skills, plans and runs

**Profiles & Skills** (sidebar) holds reusable agent setups:

- A **profile** has a name, instructions (added to the agent's system prompt), an
  optional model, and optional overrides of the permission levels and limits. Pick
  it in the chat next to the mode switch (Agent mode). A profile can be given more
  autonomy than the global settings, but never more than the global *ceiling*, and
  changing its permissions asks for your password like the settings do.
- A **skill** is a set of instructions for one kind of task. Agents only see its
  name and description until a task needs it; then they load it with a tool. Import
  `SKILL.md`-style files (front matter with `name` and `description`, then Markdown)
  or write your own; export turns them back into such files.

## Skills as slash commands

Type **/** at the start of a message (or use the **/** button) and pick a skill: the
message is answered with that skill's instructions, in Chat and in Agent mode. The
skill is shown on your message and keeps applying to your replies that continue it,
for example your answers to a practice task. A complete command typed or pasted, such
as `/study what are objects in javascript`, works too.

Anemo comes with these skills:

| Command | What it does |
| --- | --- |
| `/study` | Teaches a concept in small steps: a short explanation and example, then one practice task at a time, checked and corrected, each a little harder |
| `/plan` | Turns a project, task or idea into a plan: goal, scope, steps, risks, timeline, first next action |
| `/review` | Honest, balanced feedback on an idea, plan or draft: strengths, weaknesses, nuances, blind spots |
| `/fact-check` | Checks claims and numbers and rates each one, with sources (switches to Agent mode to use web search) |
| `/brainstorm` | Lots of varied ideas, grouped, with the most promising ones picked out |
| `/decide` | Compares options against what matters to you and recommends one |
| `/rewrite` | Makes a text clearer and tighter, keeps your meaning and voice, and explains the changes |
| `/diagram` | Shows an explanation, process, plan or numbers as a picture: a flowchart, mind map, timeline, sequence diagram or chart |

**Settings → Skills** is where you create, edit, import and switch skills on and off.
For each skill you choose its command, icon, the hint shown in the message box,
whether it is offered as a /command, whether agents may load it on their own, and
whether choosing it switches to Agent mode (for skills that need tools). Built-in
skills can be edited or switched off; once you edit one, updates of Anemo no longer
change it, and **Reset to original** brings the shipped text back.

**Plan review** (Settings → Agent Permissions, or per profile): the agent proposes
a plan and waits before taking any action. You can approve it, edit the steps first,
or send it back with feedback. If the agent later changes the steps, it asks again.

**Pause** stops an agent run at the next safe point (the current step finishes,
nothing new starts); no worker is held while it is paused. **Resume** it from the
chat or the run's page, optionally with a message the agent reads first; while a
run is paused you can also edit its plan. Stop cancels it for good.

**Limits** end a run gracefully: steps, tool calls, working time (paused time does
not count), cost (for models with known prices) and failed actions in a row. The
agent then writes a short summary of where it got to. Long conversations are
**compacted**: older steps are summarized by the *Summaries* model (Settings → Providers &
Models) so the agent keeps working within the model's context window. Very long
tool results are shortened for the model; the full text is saved, the agent can
page through it, and you can download it from the run.

**Runs** lists every agent run with its status, profile, time, tokens and cost, and
opens each one with its plan, tool calls, approvals, file changes and answer.

## Diagrams, charts and math

Answers, documents, shared pages and automation results show **diagrams, charts and
formulas** drawn instead of as code. They are ordinary Markdown, so the text stays
readable in any other tool:

- **Diagrams**: a ```` ```mermaid ```` block ([Mermaid](https://mermaid.js.org/)):
  flowcharts, mind maps, sequence diagrams, timelines, Gantt charts, state diagrams,
  pie charts.
- **Charts**: a ```` ```chart ```` block with a little JSON: `type` (line, bar, area or
  pie), `title`, the `x` labels and one or more `series` with a `name` and a value per
  label, optionally a `unit`. Charts use the app's colors and show values on hover.
- **Math**: `$…$` in a sentence, `$$…$$` on its own line (LaTeX, drawn with KaTeX).
  Prices like "\$5 and \$10" stay text.

Each diagram and chart has a bar to see its **source**, **copy** it, **download** it
as SVG or PNG, and open it **full screen** (zoom with the wheel or + and −, drag to
move). While an answer is being written, a block shows as code until it is complete.
One that can't be drawn shows its source and the error; in a chat, **Fix diagram**
asks the model to send a corrected one.

The models are told these blocks exist, and the built-in **/diagram** skill asks for
one directly ("show this as a mind map"). In a document, a diagram shows drawn with
an **Edit** button that opens its source. Mermaid is only downloaded by a page that
shows a diagram. Diagrams can't run scripts or load anything from other sites (see
[security](security.md#diagrams-charts-and-math)).

## Sub-agents

An agent can hand a self-contained part of a task to a sub-agent and continue
with its result; several can work at the same time. This is **off by default**:
set *Start sub-agents* in Settings → Agent Permissions to allow it (or to ask
first).

- A sub-agent only gets the task it was given, and may use another agent profile.
- It can never do more than the agent that started it: every action is checked
  against its own permissions and those of every agent above it, and the
  strictest answer wins. If it needs your approval, the request appears inside the
  parent's activity in the chat.
- It works within what the parent had left of its limits (steps, tool calls,
  time, cost), and what it uses is counted against the parent.
- At most 3 sub-agents of one agent work at once, at most 10 per task, and
  sub-agents cannot start their own unless you raise *Sub-agent levels* in the
  limits (up to 3).
- Stopping a run stops its sub-agents.

## Documents

**Documents** are plain Markdown files in the `documents/` folder of your
workspace, so the app, agents, the file manager and any other Markdown tool work
on the same files. Sub-folders are groups; images you drop in go to
`documents/_assets/`.

- **Editor:** rich text (headings, lists, checklists, tables, code blocks, links,
  images) that reads and writes Markdown, or the Markdown source itself. Documents
  using raw HTML or footnotes open as source, because the rich editor would lose
  those; so do documents with formulas the rich editor would change (LaTeX such as
  `\,` or `\{`). Diagram and chart blocks are shown drawn, with an *Edit* button for
  their source (see below).
- **Autosave** about a second after you stop typing. If the file was changed
  somewhere else in the meantime (an agent, another tab), nothing is overwritten:
  you choose which version to keep. With no unsaved changes, outside changes just
  appear.
- **History:** every document keeps its last 50 versions (your autosaves within
  10 minutes count as one), marked as yours, an agent's, or made outside the app.
  Restoring one keeps the current text in the history.
- **Agents** can list, read, search, create and edit documents. Reading follows the
  file-read permission and the folder access for `documents`; writing has its own
  category, *Edit documents* (asks by default). Their changes are in the history
  and can be reverted from the run.
- **Links to tasks, files and other documents:** the toolbar button *Link to a
  document, task or file* inserts a link to one of them, shown as a small labelled
  chip. Clicking a link in the editor opens it: a document here, a task in the task
  list, a file in Files, another site in a new tab. They are ordinary Markdown links
  (`/documents/<id>`, `/tasks?task=<id>`, `/files?path=<path>`), and links to a file
  are updated when it is renamed or moved in Files. A document lists what links to it.
- **Links to a part of a document:** add `#text=<a few words from it>` to point at a
  passage, or `#<heading>` for a section (`/documents/<id>#scams-to-watch-for`).
  Opening the link scrolls there and highlights it until you click or type in the
  document. Agents get each document's link from their document tools, so answers can
  quote a passage and link straight to it; a link written with the document's file
  (`/documents/<folder>/<name>.md`) opens that document too.
- **Delete** moves the file to the workspace trash (Files → Trash).

## Tasks and calendar

**Tasks** have a status (to do, in progress, waiting, blocked, done), priority, due
date (with an optional time), project and tags. A task with a due date can
**repeat** (every day, weekday, week, 2 weeks, month or year): finishing it adds the
next one. The list groups them by when they are due (overdue, today, next 7 days,
later, no date); the board shows one column per status and lets you drag cards
between them (on a phone the columns are stacked).

A task opens in a wide editor laid out like a document: the title, status and
**notes** take most of it, and a side panel holds the schedule, project, priority and
tags. Notes are written in the same rich text editor as documents and saved as
Markdown; they can link to a document or another task, and a document can link to a
task. In the list, a task with notes has an arrow that shows the start of them. A
link to a task (from a document, other notes or search) shows it in the list, marked
and with its notes open, rather than opening the editor.

**Checklists, subtasks and *waits on*.** Three ways to break up and order work:

- A **checklist** holds quick steps inside one task: add, tick, edit and remove them in
  the editor (Enter adds the next one). The list and the board show how far it is
  ("3/5"). A repeating task's next one gets the same checklist, unticked.
- **Subtasks** are tasks of their own (status, due date, notes, attachments) that belong
  to another task, one level deep. Add them in the task's side panel, where they get the
  task's project and tags, or make an existing task one with *Subtask of*. In the list
  they are folded in under their task (the arrow shows them); on the board they are
  cards of their own that name their task. Finishing a task with open subtasks asks
  whether to finish them too or keep them open. Deleting a task keeps its subtasks, as
  ordinary tasks.
- **Waits on** (*blocked by*): pick the tasks that have to be done first. While any of
  them is open the task shows *Waits on* and moves from *to do* to *blocked*; when the
  last one is done it moves back to *to do* and you get a notification. The other task
  lists it under *Blocks*. Loops (A waits on B, B waits on A) are refused, and deleting a
  task removes it from what it blocked.

Search finds checklist items too.

**Attachments.** A task can have files attached. Upload them in the task (they go to
the project's folder, or `files/` without a project) or pick existing ones from Files.
The file stays in Files; the task links to it, and the link keeps working when you
rename or move the file there. Removing an attachment leaves the file alone. Notes
and documents can link to files the same way (*Link* → *Files*), and a file's details
in Files show which tasks and documents use it; deleting it says so first ("Linked
from 2 tasks and 1 document."). Agents can attach files too (*Manage tasks*, plus
read access to the file's folder).

**Calendar** has month, week, day and agenda views. Events can be timed or
all-day and can repeat (daily, weekdays, weekly, every 2 weeks, monthly, yearly,
optionally until a date). For a repeating event you choose whether a change
applies to that one occurrence or the whole series. Tasks with a due date appear
on the calendar too (dashed outline). Click a day to add an event; drag entries to
move them.

Times follow the time zone of your browser. A repeating event keeps its local
time when the clocks change. Tasks without a time, and times given by agents
without a zone, use the time zone from **Settings → General**.

**Reminders** (on events and tasks) arrive as notifications; see below.

**Agents** can list, add, change and delete tasks and events, including checklists,
subtasks and what a task waits on. Changes follow the
*Manage tasks* and *Manage calendar* permissions; deleting counts as a risky
action, so the default level asks you first.

## Appearance and profile

**Settings → Appearance** changes the look of the whole app at once, and the change is
saved on the server, so it follows you to every device (or tick *Use a different
appearance on this device* to keep one browser to itself):

- **Theme** (light, dark, system), **accent color** (presets, a color picker or a hex
  code; hover shades and the text on it are worked out from it) and an optional
  **background tint** with a strength slider. When a choice makes text or buttons
  hard to read, the page says so, with the WCAG contrast ratio.
- **Fonts** for the interface and for code: the default, fonts that come with Anemo
  (Inter, IBM Plex Sans, Nunito, Source Serif 4, JetBrains Mono, Fira Code, IBM Plex
  Mono), system fonts, or a font file you upload (WOFF2, WOFF, TTF, OTF, up to 4 MB).
  Nothing is loaded from Google Fonts or any other site.
- **Background** behind the whole app: an animated gradient, or a picture (PNG, JPEG,
  WebP, AVIF, GIF, up to 15 MB) or video (WebM, MP4, up to 40 MB), with blur, dim and
  fit (fill, fit, tile). Photos lose their EXIF data (location, camera) when they are
  saved. Anything that moves shows a still frame when your system asks for reduced
  motion, and on phones unless you turn on *Animate on phones too*; it pauses while the
  tab is hidden. Videos are muted and have no controls.
- **Frosted glass**: the sidebar, cards, dialogs and the message box turn translucent
  over the background. It stays solid when your system asks for less transparency or
  the browser can't blur.
- **Export / Import** the appearance as a small JSON file (uploads are referred to,
  not included).

**Settings → Profile** sets your **display name** and **avatar** (crop it to a square;
the server makes small copies of it). They show in the sidebar, next to your messages
in chats and next to your prompts on the Code page; without an avatar, your initials.

These work in the browser and the installed app (PWA). The Android voice app and the
Windows desktop client are native apps and look as they always do.

## Home

**Home** is a page of widgets: the focus timer, the music player, today (what is due
and what you have focused), the daily note, open tasks, this week, recent documents, a box to ask
Anemo something, **Needs you** (approvals, memory suggestions, failed automations,
overdue tasks; hidden while empty), the latest result of an automation (**Briefing**) and what is coming up.
Every widget follows the project switcher.

The **Daily note** is for today's important short notes: a number to call back, a
thought to pick up later, the three things that must not slip. Type a line and press
Enter; tick notes off, click one to edit it, drag it by its grip (or focus the grip and
use the arrow keys) to move it, and delete it with ×. Nothing to open or save. The
arrows go back to earlier days, *Today* comes back. The day turns over at midnight in
the time zone from **Settings → General**, where you can also have unticked notes
carried over to the next day. Each day is an ordinary document,
`documents/daily/<date>.md` (with a project chosen, that project's own daily note in
`documents/<project>/daily/`), so it has a history, is found by search, can be
linked to, and agents can read it. The ↗ button opens it in Documents.

**Edit layout** (or E) lets you drag widgets around, make them wider or taller, hide
them and add them back; **Reset** goes back to the default. The layout is saved on the
server, so every device shows the same one (a phone shows it as one column). Under
**Settings → General** you choose what opens when you open Anemo: Home or a new chat.

## Focus

**Focus** is a pomodoro timer: focus, a short break, and after a few rounds a long
break. Link it to a task (or start it from a task's menu with *Focus on this*), and
the time counts for that task and its project. Space starts and pauses, R resets, S
skips to the next phase and + adds a minute.

The timer runs on timestamps, not by counting ticks, so it stays right in a background
tab, after a reload, or with the laptop asleep. While it runs it lives on that device;
each finished focus session is saved on the server (also when you were offline: it
is sent when the connection comes back). Lengths, rounds, auto-start, the chime and a
daily goal are under **Settings → Focus**, the same for every device.

## Music

**Music** plays what you paste: a YouTube video or playlist, a SoundCloud track or
set, or a link to an audio file or internet radio stream. There are also ambient
sounds (rain, ocean, brown, pink and white noise) to play on their own or under the
music, each with its own volume.

Tracks you add are kept in your **library** and can be put in **playlists**; both are
stored on the server. The queue, what is playing, shuffle, repeat and the volume are
per device, like a phone's own player. A track that won't play (removed, or blocked
from playing on other sites) is skipped, up to three in a row; after an interruption
the player picks up where it was. Music keeps playing while you move between pages.

## Dynamic Island

The **Dynamic Island** is the small dark pill at the top of the page while the timer
or music is going. It shows the time left or what is playing; click it (or tap it on
a phone) to open the controls: pause, skip, the next track, volume. It also shows
short alerts: a focus phase ending, a new track, an agent that finished or is waiting
for your approval (click to open that chat). With *reduce motion* turned on in your
system, it fades instead of morphing.

## Stats

**Stats** counts your focus time per day, week, month or a range you pick: the total,
daily average, streaks, a heatmap of the last six months, when in the day you focus,
your top tasks and projects by focus time, tasks finished, and what agents did (runs
and their cost). Days follow the time zone from Settings → General. It narrows to the
project in the switcher.

**Agents** can read your focus stats and sessions (*Focus & music*, allowed by
default), and start the timer or queue music on the device you used last (*Control
the timer and music*, asks first). With no Anemo tab open anywhere they say so. A
ready-made **Daily summary** automation (Automations → *Start from a template*)
sums up your focus and tasks each evening; it does nothing until you save it.

## Notifications

Reminders, the results of automations and messages from agents are listed under
**Notifications** (the bell in the sidebar shows how many are unread). While the
app is open they also pop up as a notice.

In **Settings → Notifications** you choose where else they go:

- **Push notifications**: arrive on your phone or computer even while Anemo is closed.
  Turn them on in each browser or phone you want them on (*Push notifications on this
  device*); every device is listed with when it last received something, and for each
  you pick which kinds it gets, or remove it. Tapping a notification opens what it is
  about. Works in Chrome, Edge and Firefox, and on an iPhone or iPad (iOS 16.4 or
  later) once Anemo is on the Home Screen: open it from there to turn push on. Needs
  HTTPS.
- **Approve from the notification**: when an automation is waiting for a plain yes or
  no, its push notification has **Allow once** and **Deny** buttons. Each works one
  time, only for that request, and only while it is still waiting; anything else (for
  example *Allow for this run*) is answered in the app. iPhones and iPads don't show
  buttons on web notifications: tap it to answer in the app.
- **Desktop notifications**: shown by your browser while Anemo is open in a tab
  you are not looking at. This is a per-browser choice and needs HTTPS. A browser with
  push on shows push notifications instead.
- **Discord**: add a channel's webhook URL (channel settings → Integrations →
  Webhooks) to get notifications there. The URL is stored encrypted and never shown
  again; for each channel you pick which kinds of notification it receives. Sending is
  retried when Discord is unreachable.

A notification sent to a device says only a line or two, encrypted so the browser's
push service can't read it. Details in [docs/security.md](security.md#push-notifications).

Agents can send you a notification themselves (the *Send notifications*
permission); they cannot choose or change where notifications go.

## Automations

An automation is a prompt that an agent runs by itself on a schedule: every
morning, every weekday, every few hours, once, or any cron expression. Times are
wall-clock times in your time zone and stay put when the clocks change.

Each run is a normal agent run in its own conversation (open it from the
automation's **History**), with the permissions of the agent profile you pick.
Because nobody is watching, you choose what happens **when an action would need
your approval**: wait and notify you (default), skip that action and carry on,
or stop the run. It is never approved automatically.

The final answer is sent to you as a notification, and can also be saved as a
document (for example `briefings/{date}`). An automation can keep short notes
between its runs, so "tell me when this page changes" works. Failed runs can be
retried. If the app was off when a run was due, that run is skipped rather than
caught up later, and a run still going when the next one is due is not stacked.

### Triggers

An automation can also run **when something happens**, besides or instead of its
schedule ("Only on events"): a task is created, changed, completed or deleted; a
calendar event or a document is created, changed or deleted; a Claude Code job starts or
ends; a computer or phone comes online or goes offline; a new file arrives in the
workspace; an automation fails; a run waits for your approval; or another service calls
the automation's **webhook** (a secret URL whose requests are signed). On the
automation's card, **Add a trigger** picks the event and, optionally, which ones (a
project, a tag, one job…), how long a burst is gathered into one run, how many runs an
hour at most, once only, and until when. The run gets the event as data, never as
instructions, and the run log says which event started each run. Every rail of a
scheduled run applies: its tools, notifications, model, limits, state note, approvals,
and never two runs at once (events that come while it runs start one more run after
it). An automation's own changes never start it again, chains of triggers stop after
three steps, and **Pause all** stops triggers too.

In a chat, the assistant can be asked to **wake you when something happens** ("tell me
when this Claude Code job is done"): when it does, the chat goes on by itself, with a
card that shows the event (not as your message). Such a wait ends after one firing and
after 24 hours unless the assistant asked for longer (at most 30 days); the Automations
page lists the chats that wait, and **Stop waiting** cancels one. The assistant can
propose an automation with its triggers in one step, which you confirm as you confirm a
schedule.

### Scripts

The **Scripts** tab holds automations that run code instead of asking a model: cheap,
the same every time, and mostly written by the assistant ("every morning, turn new
bookings into tasks"). A script is an automation like the others: the same schedules
(or "Only when started"), Run now, run log, notifications, retries, limits and "Pause
all". Its TypeScript runs in a sandbox (Deno) without network or files, and acts only
through Anemo's tools (`anemo.call("create_task", …)`, `anemo.tasks.create(…)`, an MCP
server's tools), with your permissions and approvals, and only the tools, hosts and
secrets its code declares. When it needs judgement it asks a model with
`anemo.think(prompt, data)`; the data is handed over as data, never as instructions.

Code an assistant writes or changes is saved **switched off**. The card says who wrote
it (a link to the chat) and that a change waits for review; **Review change** shows the
diff of the code and of what it may use, and only you can approve it (with your
password) and switch it on. Only the approved version, exactly as you saw it, ever
runs. What a script does shows in its run's timeline and change list, and what it
creates is marked as made by "the script X". Secrets are set on the card, never shown
again, and filled in only in request headers to the script's declared hosts.

## MCP servers

MCP servers give agents extra tools (GitHub, a database, your smart home, …).
Add them in **Settings → MCP**:

- **Remote servers** are reached by URL (Streamable HTTP, or the older SSE type),
  with optional headers such as an API key.
- **Local servers** are programs (`npx …`, `uvx …`). They run in a separate
  container, the MCP host, which has internet access but no route to the database,
  no workspace and none of the app's secrets. It is off by default; start it with
  `docker compose --profile mcp up -d`.

Headers and environment variables are stored encrypted and never shown again.

Each MCP tool goes through the same permission system as built-in tools. The
*MCP tools* level in Agent Permissions is **Always ask** by default; per tool you
can turn it off, let it run without asking, or never allow it. Servers describe
their tools as read-only or destructive; those are only hints, which you can
correct. If a server later changes a tool, or adds one, it asks every time until
you have looked at it, and runs already in progress do not get the changed tool.

Only add servers you trust: a server sees what agents send to its tools, and its
answers can try to steer the agent.

**MCP triggers.** An automation (or a chat that asked to be woken) can run when a
connected server sends a notification: a resource changed (`notifications/resources/updated`,
for the resource URI you name), its list of tools, prompts or resources changed, or (older
servers) a log message. Add one on the Automations page with **Add a trigger** → *MCP server
notification*: pick the server, the kind of notification and the resource URI (exact). While
such a trigger is on, the worker keeps one connection open to that server (local ones through
the MCP host), subscribes to the resources the triggers name, and reconnects when it drops.
Bursts are coalesced (repeats within 5 seconds are one event, and a new trigger waits 30
seconds for more by default), and a server that sends more than 120 notifications a minute is
not listened to for 15 minutes; its triggers say why. What a server sends reaches the run as
data, like its tool results.

## Plugins

Plugins extend Anemo: a panel on tasks, documents or events, a page of its own in the
sidebar, a way to draw a kind of block in chat answers, commands in Ctrl+K, and ready-made
things Anemo already has (properties, saved views, templates, automations, scripts, MCP
servers, agent profiles, skills, themes). Manage them in **Settings → Plugins** (a shield
section: installing and approving ask for your password again).

- **Install** from a `.zip`, a public Git repository (https), or one of the examples
  shipped with Anemo (*Word count*, *Today board*, *Weekly review*). An assistant can also
  build one for you in a chat (below).
- **Nothing runs until you approve it.** A new plugin waits for review. The review
  lists what it may do, grouped by risk (read-only; writes your data; network,
  notifications and tools; devices and shell, which ask every time) and what it adds.
  Approving needs your password and grants those permissions to the plugin.
- **Updates.** An update you install yourself that asks for nothing the plugin wasn't
  already allowed (and adds or changes no MCP server) applies at once. One that asks for
  more waits for review, with the differences in permissions, manifest and every file,
  while the version you approved before keeps running. Changes an assistant makes always
  wait for review.
- **Its page** (click a card: it grows into the page) shows the readme, permissions,
  contributions, versions, where it came from (the zip, the Git address and commit, or
  the chat that built it), what it stores, and its own settings if it has any. Switch it
  off, approve or reject an update, or uninstall it there; uninstalling asks whether to
  keep what it made (its properties, views, automations, documents…) or remove it (things
  it wrote go to the trash).
- **Turn off all plugins**, at the top of the section, stops every plugin at once
  without changing each one's own switch.
- **Building with the assistant.** In Agent mode the assistant has plugin tools (an
  authoring guide, create, change, validate, preview). What it builds lands switched off
  and waiting for your review, marked *Made by the assistant* with a link to the chat; it
  can never approve or switch on a plugin. *Continue building with the assistant* on the
  plugin's page opens a chat linked to it. *Preview* tries a version before you approve
  it: it can read what it asks to read, and everything else asks you first.

What a plugin draws runs in a sealed frame: it can't see your login, can't reach any
server, and asks Anemo for everything through a short list of methods, each checked
against what you approved. What it writes is marked as made by "the plugin X". How a
plugin is written: `docs/specs/CONTRACTS-plugins.md` and the authoring guide
(`backend/app/features/plugins/guide.md`).

A plugin acts on its own permissions wherever it runs, its scripts included: your agent
permission levels are about what models may do, not plugins. Plugins work on a plain
`localhost` install; they need no extra domain.

## Search

Press **Ctrl+K** (⌘K on a Mac) anywhere, or the search button next to *New chat*,
to search everything: chats, documents, memories, tasks, calendar events, files
(by name) and automations. Typing a page name ("calendar", "settings mcp") jumps
there. Arrow keys move, Enter opens. It also does things: *Start focus*, *Pause or
resume the timer*, *Play or pause music*, *Next track*, *Paste a music link…*,
*Edit home layout* and *Keyboard shortcuts*.

*All results* opens the search page, where you can filter by kind. Every word you
type has to match. On that page documents and memories are also found by meaning
when an embedding model is set (Settings → Providers & Models); the quick box
matches words only, so typing never calls a model.

## Keyboard shortcuts

Press **?** anywhere (outside a text field) to see every keyboard shortcut: the ones
for the page you are on first, then those that work everywhere, then the rest. Esc
closes it. *Keyboard shortcuts* in the search box and **Settings → General** open the
same list. On a Mac it shows ⌘ and ⌥ instead of Ctrl and Alt. Phones and tablets
without a mouse or trackpad don't get it.

## Usage

**Settings → Usage** shows model calls, tokens and cost for a period: totals, a
chart per day, a breakdown by model, kind of work, provider, agent profile or
automation, and every single call. A cost is what the provider reported, or is
worked out from the prices you set for a model; without either it is shown as
*unknown*, never as $0.

## Memory

The assistant remembers things about you across conversations, and everything it
remembers is on the **Memory** page, where you can add, edit, archive and delete it.

- **Say it:** "remember that I prefer TypeScript", "forget where I used to live".
  This works in Chat and Agent mode (the model needs tool support) and is saved at
  once, with a notice and *Undo*.
- **Noticed in conversations:** a few minutes after a chat goes quiet, the *Memory*
  model reads it for lasting facts and preferences. By default these are
  **suggestions** you approve on the Memory page (sidebar badge); in **Settings →
  Memory** you can have them saved automatically, or switch this off.
- **Used when relevant:** for each message, memories that fit it are put into the
  model's context, plus those marked *Always in context* and all *Instructions*.
  A run's page lists which memories it was given.
- **Search by meaning** needs an embedding model (Settings → Providers & Models →
  Embeddings, e.g. `text-embedding-3-small` or a local model in Ollama). Without
  one, memories are found by their words. After changing the model, use *Index all
  memories again* in Settings → Memory.
- Things that look like passwords, keys or tokens are never stored as memories.

Memories are sent to the model provider as part of your messages, like the rest
of the conversation.

## Web search and web pages

Agents can **search the web** through your own [SearXNG](https://docs.searxng.org/)
instance, **read web pages** (main content as Markdown; also PDFs, text and JSON)
and **call HTTP APIs**. Set it up in **Settings → Web & Search**: the SearXNG URL
(or `SEARXNG_URL` in `.env`) with a *Test search* button. SearXNG must allow JSON
output: in its `settings.yml`, `search: formats: [html, json]`.

Whether agents may use these is set per category in Agent Permissions (*Web
search*, *Read web pages*, *External API calls*). Calls other than GET, such as
POST or DELETE, count as moderate risk.

Web pages can't send agents into your network: every connection agents make
(including redirects) is checked against the address it really goes to, and
private, loopback, link-local, CGNAT and cloud-metadata addresses are refused,
as are this server's own containers. To let agents use a service at home (say
Home Assistant), add its host name, IP address or range under **Allowed hosts**.
Page contents are marked as untrusted for the model, but a page can still try to
mislead it, so keep approvals on for anything that changes things.

## Browser

For pages that need JavaScript, clicking or forms, agents can drive a real
headless browser (Chromium): open a page, click, type, scroll and take
screenshots. After each step the agent gets the page as text with a numbered
list of what it can click or type into, and a screenshot of every step is kept
in the run's timeline for you.

The browser runs in its own container, which is off by default. Start it with
`docker compose --profile browser up -d` (about 1.3 GB); agents only get the
browser tools while it is running (Settings → Agent Permissions shows "browser
not running" otherwise). To have it start with everything else, add
`COMPOSE_PROFILES=browser` to your `.env` (or `browser,mcp` for both).

- Each chat has its own private browser, kept open between the agent's turns and
  closed after 30 idle minutes (or with the bin button). Nothing is shared between
  chats, and downloads are refused.
- **You can use that browser too.** The window button in a chat's header shows the
  agent's browser live next to the chat (or in a separate window; on a phone, on its
  own page). Click, type and scroll in it, or enter an address. This is how you log
  in somewhere for the agent, or answer an "are you human" check yourself: the agent
  never tries to get past those, and continues in the same browser afterwards.
- All of the browser's traffic passes a guard inside that container that refuses
  addresses on your own network (your router, NAS, other containers) unless you
  allowed the host in **Settings → Web & Search**. This also holds for redirects,
  embedded content and DNS tricks.
- The *Browser automation* permission is **Always ask** by default. Choosing
  "allow for this run" on the first request covers the rest of that run's
  browsing.

What a page shows is untrusted: it can try to steer the agent, which is why
actions with consequences stay behind your permissions.

## Your Claude subscription as a model

Anemo can use your own Claude subscription (Pro or Max) instead of API credits, by
driving the official Claude Code CLI in an optional container. Claude Code acts only
as the model: every tool call goes through Agent Permissions as usual, and it has no
tools, connectors or memory of its own. Start it with
`docker compose --profile claude up -d`, sign in once with
`docker compose exec -it claude-runner claude auth login`, then add a provider of type
*Claude subscription (Claude Code)* in Settings → Providers & Models (no key needed).
Chats, agent runs and automations on these models count against your subscription's
usage limits; prompt caching is set up so each request after the first reads the
conversation from the cache. Details: [docs/claude-code.md](claude-code.md).

## Shell commands

Agents run commands in a separate **sandbox** container (Debian with git, Python,
Node/npm, curl, jq, ripgrep, sqlite3, make), never in the app itself:

- no root and no Linux capabilities, read-only system files, CPU/memory/process
  limits; only the workspace (`/workspace`) and a scratch home folder are mounted;
- **no network at all** by default. A command that needs the internet (package
  installs, `git clone`) runs in a second container, `sandbox-net`, and needs the
  *Shell with network* permission. Note that "internet" includes your LAN;
- neither sandbox can reach the database, Valkey, the app or each other.

Every command is rated *safe*, *moderate* or *dangerous* before it runs (e.g.
`ls` is safe, `npm install` moderate, `rm -rf`, `git push --force` or
`curl … | sh` dangerous), so *Ask for dangerous actions* lets ordinary commands
run and asks you first for the risky ones. Commands stop after 2 minutes by
default (the agent can ask for up to 10). Output streams live into the chat.

**SSH to your servers.** Agents can use `ssh`, `scp` and `rsync` from commands
that have network access. They use their own key, created by the `sandbox-net`
container on first start. Its public half is under **Settings → Agent
Permissions → SSH from agent commands**: add it to `~/.ssh/authorized_keys` on
the server (ideally for a dedicated account, prefixed with
`from="<Docker host IP>"`). Password logins are not possible. For
`ssh host 'command'`, the command that runs on the server is rated too.
`host.docker.internal` is the Docker host itself.

Shell commands can only *start* in folders agents may change, but a running
command can reach every folder in the workspace, and its file changes can't be
reverted with one click like the file tools' changes. Keep private data outside
the workspace, or set *Run shell commands* to *Never*.

## Files

**Files** browses the workspace folder (`WORKSPACE_PATH`): upload, edit text and
code, move, and delete to a trash you can restore from. Saving is refused if the
file changed since you opened it (for example, an agent edited it); you can then
load the other version or overwrite it.

Documents live in `documents/` but are shown under **Documents**, so Files hides that
folder (turn it back on under Settings → Workspace).

**Settings → Workspace** sets what agents may do in each top-level folder: *Hidden*,
*Read only* or *Read and change*. This applies on top of Agent Permissions.

Every file an agent creates, edits, moves or deletes is listed under **Files
changed** in its answer, with a **Revert** button. Agent deletes go to the trash.

Agents can also look at images in the workspace (PNG, JPEG, GIF, WebP, BMP, TIFF)
when the model supports images. Large images are scaled down first, and the answer
shows a thumbnail of what the agent saw.

## On your phone

The whole app works at phone size: the sidebar becomes a menu (top-left button),
dialogs slide up from the bottom, and on touch screens Enter adds a new line
(send with the arrow button).

To install it like an app, open Anemo in your phone's browser over **HTTPS**
(for example through Nginx Proxy Manager) and choose *Add to Home Screen*
(Safari: Share menu; Chrome: ⋮ menu → *Install app*). It then opens full-screen.
Only the app's own files are cached on the phone, never your chats, files or
settings. If your server can't be reached you get a short offline page. Over
plain HTTP on your LAN it still works, as a normal website.

## Browser extension

**Anemo Companion** is a Chromium extension (Chrome, Edge, Brave) that puts Anemo in
the browser's side panel: chat about the page you're on, save pages and selections to
documents or tasks, translate and explain text on the page, YouTube notes, research
sessions with a cited write-up, Anemo's notifications, the focus timer with site
blocking, and the music player. A separate build lets the agent use tabs of your own
Chrome with your logins: reading and following links are free, every other click and
all typing wait for your approval. It is a thin client:
models, memories, documents and tools all stay on your server. Installing it, the
permissions it asks for and why: [extension/README.md](../extension/README.md).

## Voice from your phone

**Anemo Voice** is an Android app (Android 10 or later): say its wake word near the phone
(or into a Bluetooth headset paired with it), say what you want, and Anemo does it as an
agent request. When the run finishes, the phone reads the answer out.

- **Setting up.** Add a phone in **Settings → Devices** and paste its token into the
  app with Anemo's address. Voice needs a **Transcription** model (Settings → Providers &
  Models), as dictation does; without one the phone says so and names that setting.
- **What happens to a recording.** It is transcribed, then the *Dictation clean-up*
  model turns what you said into one clear instruction ("uh, mail Tom, no, Tim, about
  Friday's thing" becomes "Email Tim about Friday's meeting."). That instruction starts
  an agent run in the **Voice** chat. The agent is told you are listening, so it answers
  in one to three plain sentences and puts anything longer in a document or task. The
  word list from Settings → Dictation applies. The recording and the transcript are not
  kept; the instruction is saved as your message, as any message is.
- **"Cancel"** or **"never mind"** as the whole recording throws it away; **"status"**
  (or the Status button in the app) asks what is running. When nothing was heard,
  nothing starts.
- **Follow-ups.** A request within 5 minutes of an answer continues that chat, so "and
  move it to Friday" knows what "it" is.
- **A cue you can trust.** The moment the wake word is heard, music gets quiet, a short
  rising sound plays and the phone buzzes; no cue means it wasn't heard. The request may
  follow the wake word in one breath. A falling sound means the request was taken; a low
  double sound means the wake word was heard but nothing after it. The sounds follow the
  phone's system (ring) volume, not the media volume; "Vibrate with the sounds" is on by
  default, so a phone on silent still buzzes.
- **Voice mode** (a conversation without the wake word): turn it on with the **Voice
  mode** quick-settings tile, the notification's **Voice mode** button, or by saying
  **"start voice mode"** (also right after the wake word; it can be switched off in the
  app). After each answer the phone plays the start sound and listens again, in the same
  chat. It ends with the tile or the notification, by saying **"stop"** or **"end voice
  mode"** on its own, when nobody speaks for 45 seconds (30 to 90 in the app), or when the
  agent decides the conversation is over (the `voice_stop` tool, permission **Voice
  mode**, allowed by default). The commands are recognised by the phone on what you said,
  never by a model, and nothing the agent writes can turn voice mode on. Each on and off
  is in **Settings → Audit log**, with its cause.
- **What is spoken.** The final answer without Markdown, cut at a sentence end near 600
  characters, then "The rest is in the chat." A failed or stopped run says so in one
  sentence. The phone speaks with Android's own text-to-speech: the engine chosen in
  the phone's settings, which must have a voice for the language of the answers.
- **Questions and approvals by voice.** When the agent asks something (`ask_user`), the
  phone reads the question and its options and listens for your answer; "up to you"
  leaves the choice to the agent. For an approval it reads what the agent wants to do and
  asks "Allow?": yes or no decide it, anything else asks once more and then leaves it to
  the notification. A **plan review** is read out (the first six steps) and "Go ahead?"
  accepts it as proposed; changing the steps is done in the app. An action rated
  **dangerous** is never decided by voice: the phone says it needs a tap, and the push
  notification's buttons or the app decide it. Decisions made by voice are in the
  security log, marked as coming from voice. When you decide in the app instead, the
  phone stops asking.
- A phone only hears about the runs it started itself. The run's page says "Asked by
  voice from ‹phone›".

**Settings → Voice**: the agent profile for voice requests, the model that answers them
(a small, fast one keeps spoken answers quick and cheap; by default the agent's own,
and a Voice chat keeps its model for its follow-ups), the follow-up window (0
turns follow-ups off), the longest answer read out (100 to 2000 characters), whether
approvals and plan reviews may be decided by voice (questions are always answered by
voice), and one Voice chat a day or one that keeps going. The wake word, the voice the
phone speaks with, its speed and the headset are set in the app.

The app is installed from its APK; see
[deployment.md](deployment.md#anemo-desktop-and-anemo-voice). openWakeWord's pre-trained
wake word models are licensed CC BY-NC-SA 4.0 (non-commercial use only), so they are not
part of the app: it downloads them from openWakeWord's own release when you choose a
word. A wake word model you train yourself has no such limit. A spoken yes or no is
recognised in English, Ukrainian and Russian; in another language it counts as unclear
and the notification decides. Design:
[docs/specs/05-voice-android.md](specs/05-voice-android.md) and, for the cue and voice
mode, [docs/specs/07-voice-mode-android.md](specs/07-voice-mode-android.md).

<a id="devices-your-windows-computers"></a>

## Devices: your computers (Windows and macOS)

**Anemo Desktop** is a small tray program for Windows 10 and 11, and a menu bar app for
macOS 14 or later (Apple Silicon), that lets the agent see and use a computer: take a
screenshot, read the window in front, click, type, press keys, open programs and, where
you allow it, run commands in its shell (PowerShell on Windows, zsh on a Mac). Put it on
the agent's own VM, your main PC or your laptop; each one is a **device** with its own
name, token and trust level. It only connects out to Anemo (one WebSocket, through the
address the web app uses); no port is opened on the computer. The client tells Anemo
which system and shell it has, and the agent sees it in its turn context.

**Settings → Devices** lists your computers and phones, whether they are connected now,
the client's version and, for a computer, whether *Allow control* is on. **Add a
device** with a name ("VM", "Desk PC"), the kind and, for a computer, the trust level.
Anemo shows the device's token once: paste it into the client with Anemo's address.
Rename a device (the agent finds it by name), change its trust level (this asks for your
password), or delete it: its token stops working and its connection closes at once.
(Revoking a device's token from the general token list instead closes its connection
within a minute.)

**Trust levels**, per computer:

| Level | Looking (screenshot, window text) | Acting (click, type, keys, open) | Shell (PowerShell, zsh) |
|---|---|---|---|
| **Watched** (the default; your own PC and laptop) | as the permission says | asked every time | not offered |
| **Trusted** (the agent's own VM) | as the permission says | as the permission says | as the permission says |

"As the permission says" means the three categories in **Settings → Agent
Permissions**: *See your computers* (looking is a safe action, so the default lets it go
ahead), *Use your computers* (asks by default) and *Commands on your computers* (asks by
default). So on the VM you can make acting fully autonomous while your PC always asks;
on a watched computer even *Allow for this run* doesn't cover the next click. Changing a
computer's trust level makes its client reconnect, so it reads the new level at once.

**What the agent can do.** The tools are offered only while a computer is connected, and
the agent sees which ones are, with their trust level, in its turn context.

| Tool | Does |
|---|---|
| `computer_look` | A screenshot of the screen or of one window, and the window's controls as a numbered list (role, name, value); or the list of open windows |
| `computer_act` | One action: click, double or right click (a control or a point), type, press keys (Cmd on a Mac), scroll, bring a window to the front, open a program by its Start menu name (on a Mac: its name in Applications) or a web address, put text on the clipboard. It answers with the new state |
| `computer_shell` | One command in the computer's shell (PowerShell on Windows, zsh or bash on a Mac) on a trusted computer with the shell switched on in the client, with a timeout (60 s by default, at most 10 minutes) |
| `computer_shared_screen` | What you shared last with *Share this screen with Anemo* |

PowerShell commands are rated like shell commands: one that deletes, formats, changes
users, services, the firewall or the registry, or downloads and runs something, is
dangerous; one that uses the network counts as reaching people. A Mac's zsh commands are
rated by the rules of the shell tool, plus macOS's own (AppleScript, `defaults write`,
`launchctl`, erasing disks, the Keychain, users, system settings: dangerous). Each
action's screenshot is kept in the run's timeline.

**On the computer.** The tray icon is grey while not connected and red while the agent
is acting, and a small border in the corner says "Anemo is using this computer" with a
Stop button. **Stop** (Ctrl+Alt+Shift+S) takes control away for an hour and cancels the
command that is running: the agent's tool call fails with "The user stopped control",
and no action is sent until control is allowed again. *Allow control* off makes the
computer look-only without touching Anemo. Neither stops looking: with the default
levels the agent takes screenshots of any connected computer, a watched one too, without
asking, and they are kept in the run's timeline. To have looking asked about, set *See
your computers* to *Always ask* (or *Never*), or quit Anemo Desktop. The client never
types into a password field (the agent is told to ask you to type it), never acts on the
secure desktop (UAC prompts, the lock screen), and runs the PowerShell tool only when the
computer is trusted *and* PowerShell is switched on in the client. Switching PowerShell
off takes away only that tool: while control is allowed, the agent can still open a
terminal from the Start menu or with Win+R and type into it, as an ordinary action
(asked every time on a watched computer, decided by *Use your computers* on a trusted
one). The hard boundaries are a watched computer, *Allow control* off and Stop.

**On a Mac** the client lives in the menu bar (the same menu as the Windows tray icon) and
needs two permissions that only you can give, in System Settings → Privacy & Security:
*Screen Recording* for screenshots and *Accessibility* for reading controls and acting. A
**Permissions** window explains both and opens the right page; without them the agent is
told to ask you. The client never acts on System Settings or on a password or permission
prompt, and treats a field as a password field whenever macOS's secure keyboard entry is
on. Stop is Ctrl+Option+Shift+S. The token is kept in the Keychain. Builds that aren't
signed by a developer lose both permissions at every update (allow them again).

**Share this screen** (tray menu or Ctrl+Alt+Shift+A) sends a screenshot and the text of
the window in front once, like *Share this tab* in the browser extension. The agent reads
it with `computer_shared_screen`; it is forgotten after 12 hours or when you stop
sharing, and the API never returns its content.

Automations get the computer tools only when the automation lists them. What a screen
shows is untrusted content for the model, like a web page. Installing the client:
[deployment.md](deployment.md#anemo-desktop-and-anemo-voice). Design:
[docs/specs/06-desktop-client.md](specs/06-desktop-client.md) and, for macOS,
[docs/specs/09-desktop-macos.md](specs/09-desktop-macos.md); the protocol the apps use:
[docs/device-contracts.md](device-contracts.md).
