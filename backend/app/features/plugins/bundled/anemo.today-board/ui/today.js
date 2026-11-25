/*
 * Today board: a page with today's calendar and tasks.
 *
 * Left: today's events as a time line (all-day events on top, a "now" line between what is
 * over and what is still to come). Right: the open tasks due today or earlier, grouped by
 * project; ticking one off marks it done. Clicking an event or a task opens it in Anemo.
 *
 * Calls (and the permission each needs):
 *   events.list   {from, to}             events:read
 *   tasks.list    {due}                  tasks:read     (open tasks due on or before `due`)
 *   projects.list {}                     projects:read  (the projects' names and colours)
 *   tasks.update  {id, status: 'done'}   tasks:write
 *   anemo.ui.open('task' | 'event', id)  the matching :read
 *
 * Text from Anemo (titles, places, project names) is always put in with `textContent`.
 */

const $ = (id) => document.getElementById(id)

let locale = 'en'
let timeZone // the user's time zone from Anemo (init.timeZone); the browser's if missing
let today = '' // YYYY-MM-DD of the day on the board
let events = []
let tasks = []
let projects = new Map() // id -> {name, color}
let eventsError = '' // why the calendar or the tasks couldn't be read, if they couldn't
let tasksError = ''

// ---- Small helpers ----------------------------------------------------------------------

/** An element with attributes and children (strings become text, never HTML). */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue
    if (name === 'class') node.className = value
    else if (name.startsWith('on')) node.addEventListener(name.slice(2), value)
    else node.setAttribute(name, value === true ? '' : value)
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

/** The local date as YYYY-MM-DD (the day as the user sees it on their clock). */
function isoDay(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Today as YYYY-MM-DD in the user's Anemo time zone, so the board asks the server for
 * the same day the server calls "today" (the browser's clock may be elsewhere). The
 * en-CA format happens to be YYYY-MM-DD. */
function todayInZone() {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  } catch {
    return isoDay(new Date()) // an unknown zone name: fall back to the browser's day
  }
}

/** "YYYY-MM-DD" as a local Date at midnight (new Date("YYYY-MM-DD") would be UTC). */
function fromIsoDay(day) {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** "14:00" (a task's due time) as a Date today, to show it like the events' times. */
function atTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  const date = fromIsoDay(today)
  date.setHours(h, m)
  return date
}

const time = (date) => date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
const shortDay = (date) => date.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' })

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`
}

// ---- Loading ----------------------------------------------------------------------------

async function load() {
  today = todayInZone()
  $('day').textContent = fromIsoDay(today).toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' })
  // The three reads don't depend on each other: ask for them at once.
  const [eventsResult, tasksResult, projectsResult] = await Promise.allSettled([
    anemo.call('events.list', { from: today, to: today }),
    anemo.call('tasks.list', { due: today, limit: 200 }),
    anemo.call('projects.list', {}),
  ])
  if (projectsResult.status === 'fulfilled') {
    projects = new Map(projectsResult.value.projects.map((p) => [p.id, p]))
  }
  const ok = (result) => result.status === 'fulfilled'
  events = ok(eventsResult) ? eventsResult.value.events : []
  eventsError = ok(eventsResult) ? '' : `Couldn’t read your calendar: ${eventsResult.reason.message}`
  tasks = ok(tasksResult) ? tasksResult.value.tasks : []
  tasksError = ok(tasksResult) ? '' : `Couldn’t read your tasks: ${tasksResult.reason.message}`
  renderEvents()
  renderTasks()
  renderSummary()
}

function renderSummary() {
  const parts = [plural(events.length, 'event', 'events'), plural(tasks.length, 'task', 'tasks')]
  const overdue = tasks.filter((t) => t.dueDate && t.dueDate < today).length
  if (overdue) parts.push(`${overdue} overdue`)
  $('summary').textContent = parts.join(' · ')
}

// ---- The schedule -----------------------------------------------------------------------

function renderEvents() {
  const allDay = events.filter((e) => e.allDay)
  const timed = events.filter((e) => !e.allDay).sort((a, b) => new Date(a.start) - new Date(b.start))
  $('event-count').textContent = events.length || ''

  $('all-day').replaceChildren(
    ...allDay.map((e) =>
      el('li', {}, el('button', { class: 'chip', type: 'button', onclick: () => anemo.ui.open('event', e.id) }, e.title || 'Untitled')),
    ),
  )

  const now = new Date()
  const dayStart = fromIsoDay(today)
  const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000)
  const items = []
  let nowShown = false
  for (const e of timed) {
    const start = new Date(e.start)
    const end = new Date(e.end || e.start)
    // The "now" line goes before the first event that hasn't started yet.
    if (!nowShown && start > now) {
      items.push(nowLine(now))
      nowShown = true
    }
    const state = end <= now ? 'past' : start <= now ? 'current' : 'upcoming'
    // An event that began yesterday or ends tomorrow says so instead of a time.
    const from = start < dayStart ? 'Earlier' : time(start)
    const to = end > dayEnd ? 'Tomorrow' : time(end)
    items.push(
      el(
        'li',
        { class: `event ${state}` },
        el('span', { class: 'when num' }, el('span', {}, from), el('span', { class: 'until' }, to)),
        el('span', { class: 'dot', 'aria-hidden': 'true' }),
        el(
          'button',
          { class: 'event-body', type: 'button', onclick: () => anemo.ui.open('event', e.id) },
          el('span', { class: 'title' }, e.title || 'Untitled'),
          state === 'current' ? el('span', { class: 'badge accent' }, 'Now') : null,
          e.location ? el('span', { class: 'meta' }, e.location) : null,
        ),
      ),
    )
  }
  // Every event is over (or there are none left): the line goes at the end.
  if (!nowShown && timed.length && isoDay(now) === today) items.push(nowLine(now))
  $('timeline').replaceChildren(...items)

  $('events-note').textContent = eventsError || (events.length ? '' : 'Nothing on your calendar today.')
}

function nowLine(now) {
  return el('li', { class: 'now', 'aria-label': `Now, ${time(now)}` }, el('span', { class: 'when num' }, time(now)), el('span', { class: 'rule', 'aria-hidden': 'true' }))
}

// ---- The tasks --------------------------------------------------------------------------

const PRIORITY = { 3: 'High', 2: 'Medium' } // low and none get no badge

/** Overdue first, then by time of day, then the most important. */
function byUrgency(a, b) {
  return (a.dueDate || '').localeCompare(b.dueDate || '') || (a.dueTime || '99').localeCompare(b.dueTime || '99') || b.priority - a.priority || a.title.localeCompare(b.title)
}

function renderTasks() {
  // Group by project; tasks without one go into the last group.
  const groups = new Map()
  for (const task of [...tasks].sort(byUrgency)) {
    const key = task.projectId && projects.has(task.projectId) ? task.projectId : ''
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(task)
  }
  const keys = [...groups.keys()].sort((a, b) => (a === '') - (b === '') || (projects.get(a)?.name || '').localeCompare(projects.get(b)?.name || ''))
  $('task-count').textContent = tasks.length || ''
  $('groups').replaceChildren(
    ...keys.map((key) => {
      const project = projects.get(key)
      return el(
        'div',
        { class: 'group' },
        el(
          'h4',
          { class: 'group-title' },
          el('span', { class: 'swatch', style: `background:${safeColour(project?.color)}`, 'aria-hidden': 'true' }),
          project ? project.name : 'No project',
          el('span', { class: 'subtle num' }, groups.get(key).length),
        ),
        el('ul', { class: 'list tasks' }, groups.get(key).map(taskRow)),
      )
    }),
  )
  $('tasks-note').textContent = tasksError || (tasks.length ? '' : 'Nothing due today. Enjoy the day!')
}

/** A project's colour is "#rrggbb"; anything else gets the neutral border colour. */
function safeColour(colour) {
  return /^#[0-9a-f]{6}$/i.test(colour || '') ? colour : 'var(--border-strong)'
}

function taskRow(task) {
  const overdue = task.dueDate && task.dueDate < today
  const row = el('li', { class: 'task' })
  const box = el('input', {
    type: 'checkbox',
    'aria-label': `Mark “${task.title}” done`,
    onchange: () => complete(task, row, box),
  })
  row.append(
    box,
    el('button', { class: 'task-title', type: 'button', onclick: () => anemo.ui.open('task', task.id) }, task.title),
    el(
      'span',
      { class: 'facts' },
      PRIORITY[task.priority] ? el('span', { class: `badge prio-${task.priority}` }, PRIORITY[task.priority]) : null,
      overdue ? el('span', { class: 'badge overdue', title: 'Overdue' }, shortDay(fromIsoDay(task.dueDate))) : null,
      task.dueTime ? el('span', { class: 'badge num' }, time(atTime(task.dueTime))) : null,
    ),
  )
  return row
}

/** Tick a task off: mark it done in Anemo, then let the row fade out. */
async function complete(task, row, box) {
  box.disabled = true
  row.classList.add('done')
  try {
    await anemo.call('tasks.update', { id: task.id, status: 'done' })
    tasks = tasks.filter((t) => t.id !== task.id)
    setTimeout(() => {
      renderTasks()
      renderSummary()
    }, 450) // long enough to see the tick
  } catch (err) {
    // Not changed: put the row back as it was and say why.
    row.classList.remove('done')
    box.checked = false
    box.disabled = false
    anemo.ui.toast(err.code === 'declined' ? 'The task was not changed.' : `Couldn’t complete the task: ${err.message}`, 'error')
  }
}

// ---- Keeping it current -----------------------------------------------------------------

$('refresh').addEventListener('click', load)

// Every minute the "now" line moves; after midnight the board shows the new day.
setInterval(() => {
  if (isoDay(new Date()) !== today) load()
  else renderEvents()
}, 60 * 1000)

// Back on the page after a while (another tab, another app): read everything again.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') load()
})

anemo.ready.then((init) => {
  locale = init.locale || 'en'
  timeZone = init.timeZone || undefined
  load()
})
