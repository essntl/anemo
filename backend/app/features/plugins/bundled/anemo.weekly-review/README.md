# Weekly review

Two ways to look back at your week:

- **Run weekly review** (Ctrl+K): a script collects your open tasks and this week's
  events (Monday to Sunday) and writes them into a new document,
  `documents/Reviews/Week 2026-W48.md` (the ISO week number). The document has the
  sections **Wins** (for you to fill in), **This week** (the events, day by day),
  **Open loops** (the open tasks: overdue, due this week, later or without a date) and
  **Next week** (three empty points). If the week's review exists already, the script
  leaves it alone, so what you wrote in it is never lost.
- **New weekly review from template** (Ctrl+K): a new document with the same sections and
  a question under each, for when you'd rather write it all yourself.

The script appears in **Automations** as "Weekly review", where you can see its code and
its runs, or give it a schedule (for example every Friday at 17:00). It is approved
together with the plugin, so it needs no second review.

The script acts on the permissions you granted this plugin (below), not on your agent
permission levels: once the plugin is approved, it writes the review without asking.

## Permissions

| Permission | Why |
| --- | --- |
| `tasks:read` | the script lists your open tasks and their projects (`tasks.list`, `projects.list`) |
| `events:read` | the script lists this week's events (`events.list`) |
| `documents:write` | the script writes the review (`documents.create`); the template creates a document |

The script runs in Anemo's script sandbox: it has no network and no files, and it reaches
Anemo only through the plugin's methods above, checked against these permissions.

## How it is built

An example of a plugin without UI, made only of declarations and a script:

- `scripts/weekly-review.ts`: the script (`export default async function main(input, anemo)`),
  calling the plugin's methods with `anemo.api(...)` (the same JSON a plugin's panels get)
  and returning `{outcome}` for the run log
- `templates/weekly-review.md`: the template, a Markdown file with front matter
- `anemo-plugin.json`: the script, the template and the two commands that start them
