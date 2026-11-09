/**
 * What becomes a Chrome notification, as pure functions (tested without Chrome).
 *
 *   Anemo event                         → type       click opens
 *   notification, kind reminder /calendar → calendar   Anemo's calendar
 *   notification, kind reminder (tasks)   → reminder   the task in Anemo
 *   notification, kind automation/agent   → agent      the chat (panel) or Anemo
 *   notification, kind approval           → approval   the chat in the panel
 *   notification, kind focus              → (none: the extension sees the timer itself)
 *   the shared focus timer: a focus phase ran to its end
 *                                          → focus      Anemo's focus page
 *   approval.requested                    → approval   the chat in the panel (its card)
 *   run.status: an agent run you started ended, after more than 2 minutes or while its
 *   chat isn't open in the panel           → agent      the chat in the panel
 *
 * Approval notifications never carry buttons: the details are in the panel.
 */
import type { NotificationType, Preferences } from '@/shared/preferences'
import type { HeldNotification } from '@/shared/storage'

/** A notification to show. `id` is Chrome's notification id (the same id replaces an
 *  earlier one); `urgent` ones show even during focus; `at` is when it happened (ms). */
export type Spec = HeldNotification
export type Target = Spec['target']

export interface StoredNotification {
  id: string
  title: string
  body?: string
  kind: string
  link?: string | null
}

export const AGENT_MIN_MS = 2 * 60_000
export const CATCH_UP_MS = 24 * 3600_000
export const SUMMARY_OVER = 3

const URGENT: NotificationType[] = ['approval', 'reminder', 'calendar']

/** The time inside a Valkey stream id ("1700000000000-0"), or now when unknown. */
export function eventTime(id: string | null | undefined, now: number): number {
  const ms = Number((id ?? '').split('-')[0])
  return Number.isFinite(ms) && ms > 0 ? ms : now
}

function chatOf(link: string | null | undefined): string | null {
  const hit = /^\/c\/([0-9a-f-]{8,})/i.exec(link ?? '')
  return hit ? hit[1] : null
}

function targetOf(link: string | null | undefined): Target {
  const chat = chatOf(link)
  if (chat) return { kind: 'chat', conversationId: chat }
  if (link && link.startsWith('/') && !link.startsWith('//')) return { kind: 'anemo', path: link }
  return { kind: 'none' }
}

function clip(text: string, max = 200): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

export function fromStoredNotification(n: StoredNotification, at: number): Spec | null {
  const link = n.link ?? null
  const base = { title: clip(n.title, 120), message: clip(n.body ?? ''), target: targetOf(link), at }
  switch (n.kind) {
    case 'reminder': {
      const type: NotificationType = link?.startsWith('/calendar') ? 'calendar' : 'reminder'
      return { ...base, id: `n:${n.id}`, type, urgent: true }
    }
    case 'approval': {
      const chat = chatOf(link)
      // Same id as the live approval.requested for that chat: one notification, not two.
      return { ...base, id: chat ? `approval:${chat}` : `n:${n.id}`, type: 'approval', urgent: true }
    }
    case 'automation':
    case 'agent':
      return { ...base, id: `n:${n.id}`, type: 'agent', urgent: false }
    case 'focus':
      // "Phase finished" in Anemo's Notifications list: the extension follows the timer
      // and says so itself (fromFocusEnded), once, whichever device finished the phase.
      return null
    default:
      return null
  }
}

/** A focus phase ran to its end (seen on the shared timer). Shown even though focus was
 *  on a moment ago: it is the end of focus. */
export function fromFocusEnded(notice: { id: string; title: string; body: string }, at: number): Spec {
  return { id: notice.id, type: 'focus', title: notice.title, message: notice.body, target: { kind: 'anemo', path: '/focus' }, urgent: true, at }
}

export function fromApprovalRequested(data: { run_id?: string; conversation_id?: string | null }, summary: string | null, at: number): Spec {
  const chat = data.conversation_id ?? null
  return {
    id: chat ? `approval:${chat}` : `approval-run:${data.run_id ?? ''}`,
    type: 'approval',
    title: 'Anemo needs your approval',
    message: clip(summary ?? 'An agent is waiting for you. Open it to see the details.'),
    target: chat ? { kind: 'chat', conversationId: chat } : { kind: 'anemo', path: '/runs' },
    urgent: true,
    at,
  }
}

export interface RunStatusEvent {
  run_id: string
  status: string
  conversation_id: string | null
  kind: string
  subagent?: boolean
  automation?: boolean
}

/** An agent run you started has ended: is it worth a notification? */
export function agentRunWorthNotifying(
  e: RunStatusEvent,
  durationMs: number | null,
  panelShowing: string | null,
): boolean {
  if (e.kind !== 'agent' || e.subagent || e.automation) return false
  if (!['completed', 'failed'].includes(e.status)) return false
  const long = durationMs !== null && durationMs > AGENT_MIN_MS
  const notWatched = !e.conversation_id || panelShowing !== e.conversation_id
  return long || notWatched
}

export function fromAgentRun(e: RunStatusEvent, title: string | null, at: number): Spec {
  const failed = e.status === 'failed'
  return {
    id: `run:${e.run_id}`,
    type: 'agent',
    title: failed ? 'Agent run failed' : 'Agent finished',
    message: clip(title ?? (failed ? 'Open it to see what went wrong.' : 'Open it to see the result.')),
    target: e.conversation_id ? { kind: 'chat', conversationId: e.conversation_id } : { kind: 'none' },
    urgent: false,
    at,
  }
}

export type Disposition = 'show' | 'hold' | 'drop'

/** Off in settings: dropped. During focus, anything not urgent waits until it ends. */
export function dispose(spec: Spec, prefs: Preferences, focusActive: boolean): Disposition {
  if (!prefs.features.notifications || !prefs.notificationTypes[spec.type]) return 'drop'
  if (focusActive && !(spec.urgent || URGENT.includes(spec.type))) return 'hold'
  return 'show'
}

/** One notification for several (missed while the browser was closed, or held during focus). */
export function summarize(specs: Spec[], reason: 'missed' | 'held', at: number): Spec {
  const counts = new Map<NotificationType, number>()
  for (const s of specs) counts.set(s.type, (counts.get(s.type) ?? 0) + 1)
  const words: Record<NotificationType, [string, string]> = {
    reminder: ['reminder', 'reminders'],
    calendar: ['event', 'events'],
    agent: ['agent result', 'agent results'],
    approval: ['approval request', 'approval requests'],
    focus: ['focus notice', 'focus notices'],
  }
  const parts = [...counts].map(([t, n]) => `${n} ${words[t][n === 1 ? 0 : 1]}`)
  return {
    id: `summary:${reason}:${at}`,
    type: specs.some((s) => s.type === 'approval') ? 'approval' : specs[0]?.type ?? 'agent',
    title: reason === 'missed' ? `${specs.length} notifications while you were away` : `${specs.length} notifications during focus`,
    message: parts.join(', '),
    target: { kind: 'anemo', path: '/notifications' },
    urgent: true,
    at,
  }
}

/** Missed events worth showing at startup: the last 24 hours, newest last. */
export function catchUp(specs: Spec[], now: number): Spec[] | [Spec] {
  const recent = specs.filter((s) => now - s.at <= CATCH_UP_MS)
  // Several notices about the same thing collapse to the latest.
  const byId = new Map<string, Spec>()
  for (const s of recent.sort((a, b) => a.at - b.at)) byId.set(s.id, s)
  const unique = [...byId.values()]
  return unique.length > SUMMARY_OVER ? [summarize(unique, 'missed', now)] : unique
}
