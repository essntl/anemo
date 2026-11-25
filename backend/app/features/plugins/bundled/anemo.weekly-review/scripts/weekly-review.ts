/**
 * Weekly review: writes `documents/Reviews/Week <ISO week>.md` from your open tasks and
 * this week's events.
 *
 * It runs in Anemo's script sandbox (Deno, no network, no files) and does everything
 * through tool calls, each checked by Anemo against the plugin's permissions:
 *
 *   list_tasks      tasks:read       the open tasks
 *   list_events     events:read      Monday to Sunday of this week
 *   write_document  documents:write  the review
 *
 * The tools answer in text (one line per task or event, the same text an assistant
 * reads), so the script reads the few facts it needs from those lines.
 *
 * Input (optional, from "Run" in Automations or `scripts.run`): `{"date": "YYYY-MM-DD"}`
 * reviews the week that day is in instead of this one.
 *
 * It never overwrites: if the week's review exists already (you may have written in it),
 * the run says so and changes nothing.
 */

// ---- What the sandbox gives the script ---------------------------------------------------

type ToolResult = { content: string; data: unknown }

interface Anemo {
  call(tool: string, args?: Record<string, unknown>): Promise<ToolResult>
  log(...parts: unknown[]): Promise<void>
}

interface RunInput {
  trigger?: string
  input?: { date?: string } | null
}

// ---- Dates ------------------------------------------------------------------------------
// Days are handled as "YYYY-MM-DD" strings and UTC dates, so no time zone can shift them.

const DAY_MS = 24 * 3600 * 1000

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function fromIsoDay(day: string): Date {
  return new Date(`${day}T00:00:00Z`)
}

/** Today on the clock of the machine the script runs on. */
function localToday(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** The ISO week of a day: weeks start on Monday, week 1 has the year's first Thursday. */
function isoWeek(day: string): { label: string; monday: string; sunday: string } {
  const date = fromIsoDay(day)
  const weekday = (date.getUTCDay() + 6) % 7 // Monday 0 … Sunday 6
  const monday = new Date(date.getTime() - weekday * DAY_MS)
  const thursday = new Date(monday.getTime() + 3 * DAY_MS) // its year is the week's year
  const year = thursday.getUTCFullYear()
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * DAY_MS)) + 1
  return {
    label: `${year}-W${String(week).padStart(2, "0")}`,
    monday: isoDay(monday),
    sunday: isoDay(new Date(monday.getTime() + 6 * DAY_MS)),
  }
}

/** "Mon 23 Nov" */
function shortDay(day: string): string {
  return fromIsoDay(day).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  })
}

/** "23–29 November 2026", or "30 November – 6 December 2026" across a month. */
function span(monday: string, sunday: string): string {
  const format = (day: string, options: Intl.DateTimeFormatOptions) =>
    fromIsoDay(day).toLocaleDateString("en-GB", { ...options, timeZone: "UTC" })
  const sameMonth = monday.slice(0, 7) === sunday.slice(0, 7)
  const sameYear = monday.slice(0, 4) === sunday.slice(0, 4)
  const first = sameMonth
    ? format(monday, { day: "numeric" })
    : format(monday, sameYear ? { day: "numeric", month: "long" } : { day: "numeric", month: "long", year: "numeric" })
  const last = format(sunday, { day: "numeric", month: "long", year: "numeric" })
  return sameMonth ? `${first}–${last}` : `${first} – ${last}`
}

// ---- Reading the tools' answers ---------------------------------------------------------

type Task = { title: string; due: string | null; time: string | null; project: string | null; high: boolean }
type Event = { day: string; when: string; title: string; place: string | null }

/**
 * list_tasks answers one line per task: `[id] Title (todo; high priority; due 2026-11-27
 * 14:00; project Work; …)`, or "No tasks match.".
 */
function parseTasks(text: string): Task[] {
  const tasks: Task[] = []
  for (const line of text.split("\n")) {
    // The facts in brackets always start with the status, which tells them from a title.
    const match = /^\[[^\]]+\] (.*?) \(((?:todo|in progress|waiting|blocked)(?:; .*)?)\)$/.exec(line.trim())
    if (!match) continue
    const facts = match[2].split("; ")
    const due = facts.map((f) => /^due (\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}))?$/.exec(f)).find(Boolean)
    const project = facts.find((f) => f.startsWith("project "))
    tasks.push({
      title: match[1],
      due: due ? due[1] : null,
      time: due ? due[2] ?? null : null,
      project: project ? project.slice("project ".length) : null,
      high: facts.includes("high priority"),
    })
  }
  return tasks
}

/**
 * list_events answers a first line ("Times are in Europe/Kyiv.") and then one line per
 * event: `[id] 2026-11-25 09:30-10:15  Title (at Room 1)`, `[id] 2026-11-25 (all day)  Title`
 * or `[id] 2026-11-24 to 2026-11-26  Title`. The time and the title are two spaces apart.
 */
function parseEvents(text: string): Event[] {
  const events: Event[] = []
  for (const line of text.split("\n")) {
    const match = /^\[[^\]]+\] (\d{4}-\d{2}-\d{2})(.*?) {2}(.*)$/.exec(line.trim())
    if (!match) continue
    const [, day, rest, about] = match
    // The facts in brackets after the title: a place ("at …"), a repeat rule, a source.
    // Brackets that start otherwise are part of the title ("Lunch (with Ann)").
    const facts = / \(((?:at |repeats: |source |key |edited by )[^()]*)\)$/.exec(about)
    const title = facts ? about.slice(0, facts.index) : about
    const place = facts?.[1].split("; ").find((f) => f.startsWith("at "))
    const when = rest.trim() === "(all day)" ? "All day" : rest.trim().replace(/^(\d{2}:\d{2})-(\d{2}:\d{2})$/, "$1–$2")
    events.push({ day, when, title, place: place ? place.slice(3) : null })
  }
  return events
}

// ---- Writing the review -----------------------------------------------------------------

const MAX_LATER = 15 // the tasks without a date this week, listed before "and N more"

function taskLine(task: Task): string {
  const facts = [
    task.due ? `due ${shortDay(task.due)}${task.time ? ` ${task.time}` : ""}` : null,
    task.project,
    task.high ? "high priority" : null,
  ].filter(Boolean)
  return `- ${task.title}${facts.length ? ` (${facts.join(", ")})` : ""}`
}

function review(week: ReturnType<typeof isoWeek>, today: string, tasks: Task[], events: Event[]): string {
  const overdue = tasks.filter((t) => t.due && t.due < today)
  const thisWeek = tasks.filter((t) => t.due && t.due >= today && t.due <= week.sunday)
  const later = tasks.filter((t) => !t.due || t.due > week.sunday)

  const lines: string[] = [
    "---",
    "tags: [review]",
    "---",
    `# Week ${week.label}`,
    "",
    `${span(week.monday, week.sunday)}. Written by the Weekly review plugin on ${today}: the lists are a snapshot of that moment, the rest is yours to fill in.`,
    "",
    "## Wins",
    "",
    "-",
    "",
    "## This week",
    "",
  ]
  if (events.length === 0) lines.push("No events this week.", "")
  let lastDay = ""
  for (const event of events) {
    if (event.day !== lastDay) {
      if (lastDay) lines.push("")
      lines.push(`**${shortDay(event.day)}**`, "")
      lastDay = event.day
    }
    lines.push(`- ${event.when} · ${event.title}${event.place ? ` (${event.place})` : ""}`)
  }
  if (events.length) lines.push("")

  lines.push("## Open loops", "")
  if (tasks.length === 0) lines.push("No open tasks. Well done!", "")
  const section = (title: string, list: Task[], max = list.length) => {
    if (!list.length) return
    lines.push(`### ${title} (${list.length})`, "", ...list.slice(0, max).map(taskLine))
    if (list.length > max) lines.push(`- …and ${list.length - max} more`)
    lines.push("")
  }
  section("Overdue", overdue)
  section("Due this week", thisWeek)
  section("Later or without a date", later, MAX_LATER)

  lines.push("## Next week", "", "1.", "2.", "3.", "")
  return lines.join("\n")
}

// ---- The run ----------------------------------------------------------------------------

export default async function main(input: RunInput, anemo: Anemo) {
  const asked = input?.input?.date
  const today = asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : localToday()
  const week = isoWeek(today)

  const tasks = parseTasks((await anemo.call("list_tasks", {})).content)
  const events = parseEvents((await anemo.call("list_events", { start: week.monday, end: week.sunday })).content)
  await anemo.log(`Week ${week.label}: ${tasks.length} open tasks, ${events.length} events`)

  const path = `documents/Reviews/Week ${week.label}.md`
  try {
    // Without `overwrite`, write_document refuses to replace a document that exists.
    await anemo.call("write_document", { path, content: review(week, today, tasks, events) })
  } catch (err) {
    const error = err as { message?: string; denied?: boolean }
    if (!error.denied && /already exists/i.test(error.message ?? "")) {
      return { outcome: `The review of week ${week.label} exists already; it was left as it is.`, path }
    }
    throw err // refused or failed: the run fails and its log says why
  }
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  return {
    outcome: `Wrote the review of week ${week.label}: ${count(tasks.length, "open task", "open tasks")}, ${count(events.length, "event", "events")}.`,
    path,
  }
}
