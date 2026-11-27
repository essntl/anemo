/** How the Activity page names who did what (the server sends codes; the words are here, translated). */
import { msg, t } from '@/lib/i18n'
import type { ActivityEntry, ActorKind, ObjectType } from './api'

export const ACTOR_FILTERS: { value: ActorKind | ''; label: string }[] = [
  { value: '', label: msg('Anyone') },
  { value: 'user', label: msg('You') },
  { value: 'assistant', label: msg('The assistant') },
  { value: 'automation', label: msg('Automations') },
  { value: 'script', label: msg('Scripts') },
  { value: 'plugin', label: msg('Plugins') },
  { value: 'trigger', label: msg('Started by an event') },
]

export const OBJECT_FILTERS: { value: ObjectType | ''; label: string }[] = [
  { value: '', label: msg('Everything') },
  { value: 'task', label: msg('Tasks') },
  { value: 'event', label: msg('Events') },
  { value: 'document', label: msg('Documents') },
  { value: 'file', label: msg('Files') },
  { value: 'project', label: msg('Projects') },
  { value: 'device', label: msg('On computers') },
]

export type TimeRange = '' | 'day' | 'week' | 'month'
export const TIME_FILTERS: { value: TimeRange; label: string }[] = [
  { value: '', label: msg('Any time') },
  { value: 'day', label: msg('Last 24 hours') },
  { value: 'week', label: msg('Last 7 days') },
  { value: 'month', label: msg('Last 30 days') },
]
const RANGE_DAYS: Record<Exclude<TimeRange, ''>, number> = { day: 1, week: 7, month: 30 }

/** The start of a time range, as an ISO time (rounded to the minute, so the query key stays put). */
export function sinceFor(range: TimeRange, now = new Date()): string | undefined {
  if (!range) return undefined
  const since = new Date(now.getTime() - RANGE_DAYS[range] * 86_400_000)
  since.setSeconds(0, 0)
  return since.toISOString()
}

// "Changed", "Deleted"…: what happened, by the kind of object.
const VERBS: Record<string, string> = {
  created: msg('Created'),
  changed: msg('Changed'),
  completed: msg('Completed'),
  deleted: msg('Deleted'),
  restored: msg('Restored'),
  reverted: msg('Reverted'),
  moved: msg('Moved'),
  undone: msg('Undid'),
}
const OBJECTS: Record<string, string> = {
  task: msg('task'),
  event: msg('event'),
  document: msg('document'),
  file: msg('file'),
  project: msg('project'),
  device: msg('computer'),
}
// The fields a change names, as the editors call them.
const FIELDS: Record<string, string> = {
  title: msg('title'),
  description: msg('notes'),
  status: msg('status'),
  priority: msg('priority'),
  due_date: msg('due date'),
  due_time: msg('due time'),
  remind_minutes: msg('reminder'),
  rrule: msg('repeat'),
  tags: msg('tags'),
  project_id: msg('project'),
  parent_id: msg('parent task'),
  checklist: msg('checklist'),
  blocked_by: msg('waits on'),
  location: msg('location'),
  all_day: msg('all day'),
  tz: msg('time zone'),
  start_at: msg('start'),
  end_at: msg('end'),
  color: msg('colour'),
  task_id: msg('task'),
  content_hash: msg('text'),
  name: msg('name'),
  archived: msg('archived'),
  instructions: msg('instructions'),
}

export const verbOf = (entry: ActivityEntry): string => t(VERBS[entry.action] ?? entry.action)
export const objectWord = (type: string): string => t(OBJECTS[type] ?? type)

/** "title, due date" ("properties.client" is shown as "client"). */
export function fieldsText(fields: string[]): string {
  return fields.map((f) => (f.startsWith('properties.') ? f.slice('properties.'.length) : t(FIELDS[f] ?? f.replace(/_/g, ' ')))).join(', ')
}

// Why the Undo button is off (the server's undo_blocked codes).
const BLOCKED: Record<string, string> = {
  undone: msg('This change was undone'),
  is_undo: msg('An undo is undone by changing the item itself'),
  not_undoable: msg('This change can’t be undone'),
  too_large: msg('A value it replaced was too long to keep'),
}
export const blockedReason = (code: string): string => t(BLOCKED[code] ?? BLOCKED.not_undoable)
