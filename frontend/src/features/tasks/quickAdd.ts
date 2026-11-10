/**
 * What the one-line "Add a task" box understands at the END of what was typed:
 * a day (today, tomorrow, a weekday, "next week"), a priority (!low, !medium, !high)
 * and tags (#errands). They are taken off the title; anything earlier in the text is
 * left alone, so "Read Friday Night Lights" stays a title.
 *
 *   parseQuickAdd('Call the bank fri !high')  →  title "Call the bank", due Friday, High
 */
import { addDays, today } from './dates'

export interface QuickTask {
  title: string
  due_date: string | null
  /** 0 none, 1 low, 2 medium, 3 high (as in PRIORITY_LABELS). */
  priority: number
  tags: string[]
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const PRIORITIES: Record<string, number> = { '!low': 1, '!medium': 2, '!med': 2, '!high': 3 }
/** Words that only lead up to a day: "pay rent by friday". */
const LEAD_INS = new Set(['on', 'by', 'due', 'for'])

/** The day a word names, counted from `now` ("YYYY-MM-DD"); null if it names none. */
function dayFor(word: string, now: string): string | null {
  if (word === 'today') return now
  if (word === 'tomorrow' || word === 'tmrw') return addDays(now, 1)
  const index = WEEKDAYS.findIndex((d) => d === word || (word.length >= 3 && d.startsWith(word) && word.length <= 4))
  if (index < 0) return null
  const current = new Date(`${now}T12:00:00`).getDay()
  // The next such day: a weekday typed on that same day means a week from now.
  return addDays(now, (index - current + 7) % 7 || 7)
}

export function parseQuickAdd(text: string, now = today()): QuickTask {
  const words = text.trim().split(/\s+/).filter(Boolean)
  const task: QuickTask = { title: '', due_date: null, priority: 0, tags: [] }
  while (words.length > 1) {
    const last = words[words.length - 1].toLowerCase()
    if (last in PRIORITIES && !task.priority) task.priority = PRIORITIES[last]
    else if (/^#[\p{L}\p{N}_-]+$/u.test(last)) task.tags.unshift(last.slice(1))
    else if (!task.due_date && last === 'week' && words.length > 2 && words[words.length - 2].toLowerCase() === 'next') {
      task.due_date = addDays(now, 7)
      words.pop()
    } else if (!task.due_date && dayFor(last, now)) task.due_date = dayFor(last, now)
    else break
    words.pop()
    // "… by friday": the word that led up to the day goes with it.
    if (task.due_date && words.length > 1 && LEAD_INS.has(words[words.length - 1].toLowerCase())) words.pop()
  }
  task.title = words.join(' ')
  return task
}
