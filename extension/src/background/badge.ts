/**
 * The toolbar badge has room for one thing. In order: the minutes left in a focus
 * session, a dot while a research session is active, the number of approvals waiting.
 */
import { storage } from '@/shared/storage'

export interface BadgeInputs {
  focusMinutes: number | null
  research: boolean
  approvals: number
}

export interface Badge {
  text: string
  color: string
  title: string
}

const FOCUS = '#3478f6'
const RESEARCH = '#8b5cf6'
const APPROVAL = '#d97706'

export function badgeFor(b: BadgeInputs): Badge {
  if (b.focusMinutes !== null && b.focusMinutes >= 0) {
    return { text: `${Math.max(1, Math.ceil(b.focusMinutes))}m`, color: FOCUS, title: `Focus: ${Math.ceil(b.focusMinutes)} min left` }
  }
  if (b.research) return { text: '●', color: RESEARCH, title: 'Research session active' }
  if (b.approvals > 0) {
    return { text: b.approvals > 9 ? '9+' : String(b.approvals), color: APPROVAL, title: `${b.approvals} waiting for your approval` }
  }
  return { text: '', color: FOCUS, title: 'Open Anemo' }
}

export async function applyBadge(b: BadgeInputs): Promise<void> {
  const badge = badgeFor(b)
  await chrome.action.setBadgeText({ text: badge.text })
  if (badge.text) await chrome.action.setBadgeBackgroundColor({ color: badge.color })
  await chrome.action.setTitle({ title: badge.title })
}

let pending: Promise<void> = Promise.resolve()

/** Changes some of the badge's inputs and shows the result. Calls run one after another, so
 *  two quick changes (approvals and research on reconnect) don't overwrite each other. */
export function updateBadge(patch: Partial<BadgeInputs>): Promise<void> {
  pending = pending.then(async () => {
    const current = (await storage.get('session', 'badge')) ?? { focusMinutes: null, research: false, approvals: 0 }
    const next = { ...current, ...patch }
    await storage.set('session', 'badge', next)
    await applyBadge(next).catch(() => undefined)
  }).catch(() => undefined)
  return pending
}
