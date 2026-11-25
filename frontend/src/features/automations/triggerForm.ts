/**
 * The trigger dialog's form and what the server stores (docs/specs/16-event-triggers.md):
 * a filter is {field: value or [values]}; in the form each field is one text box, where
 * commas separate several values ("urgent, home": either tag).
 */
import type { EventType, Trigger, TriggerInput } from './api'

export interface TriggerForm {
  eventType: string
  /** Field name → what was typed (empty: any). */
  filter: Record<string, string>
  debounceS: number
  maxPerHour: number
  once: boolean
  /** "YYYY-MM-DDTHH:mm" in this browser's time zone, or "" for none. */
  expires: string
  enabled: boolean
  note: string
}

export const WEBHOOK = 'webhook.received'

const pad = (n: number) => String(n).padStart(2, '0')

/** An ISO time as a datetime-local value, in this browser's time zone. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function filterText(value: unknown): string {
  return Array.isArray(value) ? value.map(String).join(', ') : value === null || value === undefined ? '' : String(value)
}

export function formFrom(trigger: Trigger | null, eventType = 'task.created'): TriggerForm {
  if (!trigger) {
    return { eventType, filter: {}, debounceS: 0, maxPerHour: 12, once: false, expires: '', enabled: true, note: '' }
  }
  return {
    eventType: trigger.event_type,
    filter: Object.fromEntries(Object.entries(trigger.filter ?? {}).map(([k, v]) => [k, filterText(v)])),
    debounceS: trigger.debounce_s,
    maxPerHour: trigger.max_per_hour,
    once: trigger.once,
    expires: toLocalInput(trigger.expires_at),
    enabled: trigger.enabled,
    note: trigger.note,
  }
}

/** The filter to save: only the fields of this event type that have something in them. */
export function filterOf(form: TriggerForm, type: EventType | undefined): Record<string, unknown> {
  const names = new Set((type?.fields ?? []).map((f) => f.name))
  const out: Record<string, unknown> = {}
  for (const [name, raw] of Object.entries(form.filter)) {
    if (!names.has(name)) continue
    const values = raw.split(',').map((v) => v.trim()).filter(Boolean)
    if (values.length === 1) out[name] = values[0]
    else if (values.length > 1) out[name] = values
  }
  return out
}

export function expiresOf(form: TriggerForm): string | null {
  return form.expires ? new Date(form.expires).toISOString() : null
}

export function createBody(automationId: string, form: TriggerForm, type: EventType | undefined): TriggerInput {
  return {
    automation_id: automationId,
    event_type: form.eventType,
    filter: filterOf(form, type),
    debounce_s: form.debounceS,
    max_per_hour: form.maxPerHour,
    once: form.once,
    expires_at: expiresOf(form),
    enabled: form.enabled,
    note: form.note.trim(),
  }
}

/** "tags: urgent · project_id: …" for a trigger's line on the card. */
export function describeFilter(filter: Record<string, unknown>): string {
  return Object.entries(filter).map(([k, v]) => `${k}: ${filterText(v)}`).join(' · ')
}
