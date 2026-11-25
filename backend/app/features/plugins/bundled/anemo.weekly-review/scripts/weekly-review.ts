/**
 * Weekly review: writes `documents/Reviews/Week <ISO week>.md` from your open tasks and
 * this week's events.
 *
 * It runs in Anemo's script sandbox (Deno, no network, no files) and does everything
 * through the plugin's methods (`anemo.api`), each checked by Anemo against the plugin's
 * permissions, which answer with the same JSON the plugin's panels get:
 *
 *   tasks.list        tasks:read       the open tasks
 *   projects.list     tasks:read       their projects' names
 *   events.list       events:read      Monday to Sunday of this week
 *   documents.create  documents:write  the review
 *
 * Input (optional, from "Run" in Automations or `scripts.run`): `{"date": "YYYY-MM-DD"}`
 * reviews the week that day is in instead of this one. Anemo also passes the user's time
 * zone (`timeZone`), so "today" and the events' times are the user's.
 *
 * It never overwrites: if the week's review exists already (you may have written in it),
 * documents.create answers with the error code `exists`, and the run says so and changes
 * nothing.
 */

// ---- What the sandbox gives the script ---------------------------------------------------

/** A refused or failed method: `code` is one of the plugin contract's error codes. */
type PluginError = Error & { code: string }

interface Anemo {
  api(method: string, params?: Record<string, unknown>): Promise<any>
  log(...parts: unknown[]): Promise<void>
}

interface RunInput {
  trigger?: string
  input?: { date?: string } | null
  timeZone?: string
}

// The parts of the contract's JSON shapes this script reads.
type ApiTask = {
  title: string
  priority: number
  dueDate: string | null
  dueTime: string | null
  projectId: string | null
}
type ApiEvent = { title: string; location: string; start: string; end: string; allDay: boolean }
type ApiProject = { id: string; name: string }

// ---- Dates ------------------------------------------------------------------------------
// Days are handled as "YYYY-MM-DD" strings and UTC dates, so no time zone can shift them.

const DAY_MS = 24 * 3600 * 1000

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function fromIsoDay(day: string): Date {
  return new Date(`${day}T00:00:00Z`)
}

/** "YYYY-MM-DD" of an instant in a time zone (en-CA happens to format dates that way). */
function dayIn(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant)
}

/** "09:30" of an instant in a time zone. */
function timeIn(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(instant)
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

// ---- From the methods' JSON to what the review shows --------------------------------------

type Task = { title: string; due: string | null; time: string | null; project: string | null; high: boolean }
type Event = { day: string; when: string; title: string; place: string | null }

function toTask(task: ApiTask, projects: Map<string, string>): Task {
  return {
    title: task.title,
    due: task.dueDate,
    time: task.dueTime,
    project: task.projectId ? projects.get(task.projectId) ?? null : null,
    high: task.priority >= 3,
  }
}

/** An event as the review lists it, on its day in the user's time zone. */
function toEvent(event: ApiEvent, timeZone: string): Event {
  const start = new Date(event.start)
  const when = event.allDay
    ? "All day"
    : `${timeIn(start, timeZone)}–${timeIn(new Date(event.end), timeZone)}`
  return {
    // An all-day event's start is midnight UTC of its day.
    day: event.allDay ? isoDay(start) : dayIn(start, timeZone),
    when,
    title: event.title,
    place: event.location || null,
  }
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
  const timeZone = input?.timeZone || "UTC"
  const asked = input?.input?.date
  const today = asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : dayIn(new Date(), timeZone)
  const week = isoWeek(today)

  const { projects } = (await anemo.api("projects.list")) as { projects: ApiProject[] }
  const names = new Map(projects.map((p) => [p.id, p.name]))
  const { tasks: open } = (await anemo.api("tasks.list", { limit: 500 })) as { tasks: ApiTask[] }
  const tasks = open.map((t) => toTask(t, names))
  const listed = (await anemo.api("events.list", { from: week.monday, to: week.sunday })) as { events: ApiEvent[] }
  const events = listed.events.map((e) => toEvent(e, timeZone))
  await anemo.log(`Week ${week.label}: ${tasks.length} open tasks, ${events.length} events`)

  const path = `documents/Reviews/Week ${week.label}.md`
  try {
    await anemo.api("documents.create", { path, markdown: review(week, today, tasks, events) })
  } catch (err) {
    if ((err as PluginError).code === "exists") {
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
