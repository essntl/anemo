/**
 * Focus mode in the worker: follows Anemo's shared focus timer, finishes a phase whose
 * time is up (also when no Anemo tab is open), and while a focus phase runs: blocks the
 * sites on the list, shows the minutes left on the badge and holds notifications back.
 *
 * Everything is worked out again from the stored timer (`focusTimer`) on each wake-up:
 * the event stream, an alarm every 30 s, an alarm at the end of the phase, the panel
 * opening, and the worker starting. So the blocking rules come off when the phase ends
 * even if the worker was asleep, or Anemo can't be reached at that moment.
 */
import type { Api } from '@/shared/api'
import { log } from '@/shared/env'
import {
  blockingUntil,
  blockRules,
  changeTimer,
  fetchMirror,
  focusMinutesLeft,
  mirrorFrom,
  phaseNotice,
  RULE_BASE,
  sitePatterns,
  steps,
  timer,
  type FocusMirror,
  type TimerOut,
} from '@/shared/focus'
import { withDefaults } from '@/shared/preferences'
import { storage } from '@/shared/storage'
import { updateBadge } from './badge'

export const FOCUS_TICK = 'anemo-focus-tick'
export const FOCUS_END = 'anemo-focus-end'

let api: Api | null = null
let onFocusEnded: (notice: { title: string; body: string; id: string }) => void = () => undefined

export function setFocusApi(next: Api | null): void {
  api = next
}

/** How a finished focus phase is announced (a Chrome notification, see events.ts). */
export function setFocusEndedHandler(fn: typeof onFocusEnded): void {
  onFocusEnded = fn
}

/** A focus phase that ran to its end, between two states seen: say so (once). */
function announce(before: FocusMirror | null | undefined, after: FocusMirror): void {
  const prev = before?.state
  const next = after.state
  if (!prev || !next || prev.phase !== 'focus' || prev.status !== 'running') return
  const end = timer.endsAt(prev)
  if (end === null || end > Date.now() + 2000 || next.sessionId === prev.sessionId || next.phase === 'focus') return
  onFocusEnded({ ...phaseNotice('focus', next, after.settings), id: `focus:${prev.sessionId}` })
}

async function save(next: FocusMirror): Promise<void> {
  const before = await storage.get('local', 'focusTimer')
  if (before && before.version > next.version) return // an older answer arriving late
  announce(before, next)
  await storage.set('local', 'focusTimer', next)
}

/** Read the timer and its settings from Anemo (connected, the panel opened). */
export async function refreshFocus(): Promise<void> {
  if (!api) return
  try {
    await save(await fetchMirror(api))
  } catch (err) {
    log.debug('focus refresh failed', { kind: (err as { kind?: string }).kind })
  }
  await tick()
}

/** Someone changed the timer (a `focus.timer` event). */
export async function onTimerEvent(out: TimerOut): Promise<void> {
  const before = await storage.get('local', 'focusTimer')
  if (before && out.version <= before.version) return
  await save(mirrorFrom(out, before?.settings ?? timer.DEFAULT_SETTINGS))
}

/** The phase's time is up: finish it, as an Anemo tab would (unless one already did). */
export async function tick(): Promise<void> {
  const mirror = await storage.get('local', 'focusTimer')
  const end = mirror?.state ? timer.endsAt(mirror.state) : null
  if (api && mirror && end !== null && Date.now() >= end) {
    try {
      const before = mirror
      const result = await changeTimer(api, mirror, steps.completeIfDue(), { retry: false })
      if (result.finished === 'focus') announce(before, result.mirror)
    } catch (err) {
      log.debug('focus completion failed', { kind: (err as { kind?: string }).kind })
    }
  }
  await applyFocus()
}

let applying: Promise<void> = Promise.resolve()

/** Badge, blocking rules, held notifications and alarms, from the stored timer. Calls run
 *  one after another (they all rewrite the same rules). */
export function applyFocus(): Promise<void> {
  applying = applying.then(apply, apply)
  return applying
}

async function apply(): Promise<void> {
  const mirror = await storage.get('local', 'focusTimer')
  const now = Date.now()
  const until = blockingUntil(mirror, now)
  const focus = { active: until !== null, endsAt: until }
  const stored = await storage.get('local', 'focusState')
  if (stored?.active !== focus.active || stored?.endsAt !== focus.endsAt) await storage.set('local', 'focusState', focus)
  await updateBadge({ focusMinutes: focusMinutesLeft(mirror, now) })
  await syncRules(until !== null)

  // Wake up when the phase ends, and every 30 s while the timer runs (the badge's minutes).
  const end = mirror?.state ? timer.endsAt(mirror.state) : null
  if (end !== null) {
    await chrome.alarms.create(FOCUS_END, { when: Math.max(end + 250, now + 1000) })
    if (!(await chrome.alarms.get(FOCUS_TICK))) await chrome.alarms.create(FOCUS_TICK, { periodInMinutes: 0.5 })
  } else {
    await chrome.alarms.clear(FOCUS_END)
    await chrome.alarms.clear(FOCUS_TICK)
  }
}

/** Sites on the list whose access was granted (each is asked for when it is added). */
async function blockableSites(sites: string[]): Promise<string[]> {
  const out: string[] = []
  for (const site of sites) {
    if (await chrome.permissions.contains({ origins: sitePatterns(site) }).catch(() => false)) out.push(site)
  }
  return out
}

/**
 * Tabs already open on a blocked site switch to the focus page too (question 49, a): a
 * rule only stops pages from loading, and sites like YouTube move between pages without
 * loading one. The focus page links back to where the tab was once focus is over.
 */
async function moveOpenTabs(sites: string[], focusPage: string): Promise<void> {
  if (!sites.length) return
  const tabs = await chrome.tabs.query({ url: sites.flatMap(sitePatterns) }).catch(() => [])
  for (const tab of tabs) {
    if (tab.id === undefined || !tab.url) continue
    await chrome.tabs.update(tab.id, { url: `${focusPage}#${tab.url}` }).catch(() => undefined)
  }
}

async function syncRules(active: boolean): Promise<void> {
  const dnr = chrome.declarativeNetRequest
  if (!dnr) return // switched off: the permission (and with it every rule) is gone
  const prefs = withDefaults(await storage.get('local', 'preferences'))
  const sites = active && prefs.features.focusBlocking ? await blockableSites(prefs.focusSites) : []
  const focusPage = chrome.runtime.getURL('pages/blocked.html')
  await moveOpenTabs(sites, focusPage)
  const wanted = blockRules(sites, focusPage)
  const existing = (await dnr.getDynamicRules()).filter((r) => r.id >= RULE_BASE)
  const same = existing.length === wanted.length && wanted.every((w) => existing.some((e) => e.id === w.id && JSON.stringify(e.condition.requestDomains) === JSON.stringify(w.condition.requestDomains)))
  if (same) return
  await dnr.updateDynamicRules({ removeRuleIds: existing.map((r) => r.id), addRules: wanted })
}

/** Signed out: forget the timer (and with it any blocking). */
export async function forgetFocus(): Promise<void> {
  await storage.set('local', 'focusTimer', null)
  await applyFocus()
}
