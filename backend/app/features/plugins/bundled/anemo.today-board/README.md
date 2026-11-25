# Today board

One page for the day ahead, under **Plugins** in the sidebar (or Ctrl+K → "Open Today board"):

- **Schedule**, on the left: today's events as a time line. All-day events are at the top;
  a line marks the current time, events that are over are dimmed and the one that is on
  now is highlighted.
- **Tasks**, on the right: the open tasks that are due today or overdue, grouped by
  project. Overdue ones show the day they were due; high and medium priority are marked.
  Tick the box to mark a task done.

Click an event or a task to open it in Anemo. On a phone the two columns become one, the
schedule first. The board moves its "now" line every minute, shows the new day after
midnight, and reads everything again when you come back to it (or press the refresh
button).

## Permissions

| Permission | Why |
| --- | --- |
| `events:read` | to list today's events |
| `tasks:read` | to list the tasks due today or earlier, and to open a task |
| `projects:read` | to show the tasks under their project's name and colour |
| `tasks:write` | to mark a task done when you tick it (it changes nothing else) |

What it writes shows "the plugin Today board" as the author in the task's history.

## How it is built

An example of a full-page plugin with its own layout, in three files and no libraries:

- `ui/today.html`: the header and the two columns
- `ui/today.css`: a CSS grid of two columns that becomes one below 640 px, and the time
  line; colours only from Anemo's theme variables
- `ui/today.js`: `events.list`, `tasks.list`, `projects.list` at once, `tasks.update` to
  complete a task, `anemo.ui.open` to open one, `anemo.ui.toast` when something fails
