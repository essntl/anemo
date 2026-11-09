/**
 * Focus mode (feature 10): Anemo's focus timer, followed and controlled from the
 * extension, and the sites blocked while a focus phase runs.
 *
 * The timer is one shared state on the server (`/api/focus/timer`, versioned): Anemo's
 * tabs and the extension all follow it, and a change made on an older version is
 * refused (409 with the current state). The rules of the timer are Anemo's own
 * (`@anemo/timer`, the frontend's timer.ts), so a phase ends here exactly as it would in
 * an Anemo tab, also when no Anemo tab is open.
 */
import * as timer from '@anemo/timer'
import type { Phase, SessionRecord, TimerSettings, TimerState, Transition } from '@anemo/timer'
import { ApiError, unwrap, type Api, type Schemas } from './api'
import { storage } from './storage'

export { timer }
export type { Phase, TimerState, TimerSettings }

type Wire = Schemas['FocusTimerState']
export type TimerOut = Schemas['FocusTimerOut']

/** The shared timer as last seen, with the settings it runs by. */
export interface FocusMirror {
  state: TimerState | null
  version: number
  settings: TimerSettings
  /** When it was last read from Anemo (ms). */
  at: number
}

export function fromWire(w: Wire): TimerState {
  return {
    phase: w.phase,
    status: w.status,
    phaseStartedAt: w.phase_started_at ?? null,
    startedAt: w.started_at ?? null,
    pausedAt: w.paused_at ?? null,
    accumulated: w.accumulated ?? 0,
    duration: w.duration,
    round: w.round ?? 0,
    taskId: w.task_id ?? null,
    sessionId: w.session_id,
  }
}

export function toWire(t: TimerState): Wire {
  return {
    phase: t.phase,
    status: t.status,
    phase_started_at: t.phaseStartedAt,
    started_at: t.startedAt,
    paused_at: t.pausedAt,
    accumulated: Math.round(t.accumulated),
    duration: Math.round(t.duration),
    round: t.round,
    task_id: t.taskId,
    session_id: t.sessionId,
  }
}

/** Settings → Focus, as the timer's rules want them. */
export function settingsFrom(focus: Schemas['FocusSettings'] | undefined): TimerSettings {
  if (!focus) return timer.DEFAULT_SETTINGS
  return {
    focusMinutes: focus.focus_minutes ?? 25,
    shortBreakMinutes: focus.short_break_minutes ?? 5,
    longBreakMinutes: focus.long_break_minutes ?? 15,
    roundsBeforeLongBreak: focus.rounds_before_long_break ?? 4,
    autoStartBreaks: focus.auto_start_breaks ?? true,
    autoStartFocus: focus.auto_start_focus ?? false,
  }
}

/** A focus phase is running: sites on the list are blocked until `endsAt`. */
export function blockingUntil(m: FocusMirror | null | undefined, now: number): number | null {
  const t = m?.state
  if (!t || t.phase !== 'focus' || t.status !== 'running') return null
  const end = timer.endsAt(t)
  return end !== null && end > now ? end : null
}

/** Minutes left in a running focus phase (for the badge), else null. */
export function focusMinutesLeft(m: FocusMirror | null | undefined, now: number): number | null {
  const end = blockingUntil(m, now)
  return end === null ? null : (end - now) / 60_000
}

export function mirrorFrom(out: TimerOut, settings: TimerSettings): FocusMirror {
  return { state: out.state ? fromWire(out.state) : null, version: out.version, settings, at: Date.now() }
}

/** Reads the timer and its settings from Anemo. */
export async function fetchMirror(api: Api): Promise<FocusMirror> {
  const [out, all] = await Promise.all([api.GET('/api/focus/timer'), api.GET('/api/settings')])
  return mirrorFrom(unwrap(out), settingsFrom(unwrap(all).focus))
}

async function recordSession(api: Api, s: SessionRecord): Promise<void> {
  await api
    .POST('/api/focus/sessions', {
      body: {
        client_id: s.clientId,
        phase: s.phase,
        started_at: new Date(s.startedAt).toISOString(),
        ended_at: new Date(s.endedAt).toISOString(),
        minutes: s.minutes,
        completed: s.completed,
        task_id: s.taskId,
      },
    })
    .catch(() => undefined)
}

/** What a finished phase says (as Anemo's timer says it). */
export function phaseNotice(finished: Phase, next: TimerState, s: TimerSettings): { title: string; body: string } {
  if (finished === 'focus') {
    return next.phase === 'long_break'
      ? { title: 'Long break', body: `Cycle complete. Enjoy ${s.longBreakMinutes} minutes off.` }
      : { title: 'Break time', body: `Session complete. Enjoy ${s.shortBreakMinutes} minutes off.` }
  }
  return { title: 'Back to focus', body: `${s.focusMinutes} minutes on the clock.` }
}

export type Step = (t: TimerState, s: TimerSettings, now: number) => Transition | TimerState

export interface ChangeResult {
  mirror: FocusMirror
  /** The change was made (false: someone else changed the timer first, and it was dropped). */
  applied: boolean
  finished: Phase | null
}

/**
 * Change the shared timer: apply `step` to the state as last seen and send it with that
 * version. If the timer changed elsewhere first, the step is applied once more to the
 * newer state (`retry`), or dropped (finishing a phase someone else already finished).
 * A focus session the step ends is recorded (Anemo stores it once per id).
 */
export async function changeTimer(api: Api, mirror: FocusMirror, step: Step, opts: { retry: boolean }): Promise<ChangeResult> {
  let current = mirror
  for (let attempt = 0; attempt < 2; attempt++) {
    const now = Date.now()
    const base = current.state ?? timer.initialState(current.settings)
    const out = step(base, current.settings, now)
    const result: Transition = 'state' in out ? out : { state: out, session: null, finished: null }
    if (result.state === base && current.state) return { mirror: current, applied: true, finished: null }
    try {
      const saved = unwrap(await api.PUT('/api/focus/timer', { body: { state: toWire(result.state), base_version: current.version, source: 'extension' } }))
      const next = mirrorFrom(saved, current.settings)
      await storage.set('local', 'focusTimer', next)
      if (result.session) await recordSession(api, result.session)
      if (result.finished) {
        const notice = phaseNotice(result.finished, result.state, current.settings)
        await api.POST('/api/focus/phase-ended', { body: notice }).catch(() => undefined)
      }
      return { mirror: next, applied: true, finished: result.finished }
    } catch (err) {
      const fresh = err instanceof ApiError && err.code === 'timer_conflict' ? (err.details as { current?: TimerOut } | undefined)?.current : undefined
      if (!fresh) throw err
      current = mirrorFrom(fresh, current.settings)
      await storage.set('local', 'focusTimer', current)
      if (!opts.retry) return { mirror: current, applied: false, finished: null }
    }
  }
  return { mirror: current, applied: false, finished: null }
}

/** The panel's buttons, as Anemo's own: start a focus phase (optionally for a task),
 *  pause, resume, skip to the next phase, stop (back to the start of the cycle). */
export const steps = {
  startFocus:
    (taskId: string | null | undefined): Step =>
    (t, s, now) => {
      let state = t
      let session: SessionRecord | null = null
      if (state.phase !== 'focus' || state.status === 'idle') {
        const chosen = timer.choosePhase(state, 'focus', s, now)
        state = chosen.state
        session = chosen.session
      }
      if (taskId !== undefined) state = { ...state, taskId }
      return { state: timer.start(state, now), session, finished: null }
    },
  pause: (): Step => (t, _s, now) => timer.pause(t, now),
  resume: (): Step => (t, _s, now) => timer.start(t, now),
  skip: (): Step => (t, s, now) => timer.skip(t, s, now),
  stop: (): Step => (t, s, now) => timer.reset(t, s, now),
  /** The phase's time is up (no-op otherwise). */
  completeIfDue: (): Step => (t, s, now) => timer.complete(t, s, now),
}

/* ── the distraction list ── */

/** "https://www.youtube.com/watch?v=…", "www.youtube.com" or "youtube.com" → "youtube.com". */
export function normalizeSite(input: string): string | null {
  let text = input.trim().toLowerCase()
  if (!text) return null
  if (!/^[a-z]+:\/\//.test(text)) text = `https://${text}`
  let host: string
  try {
    const url = new URL(text)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    host = url.hostname
  } catch {
    return null
  }
  host = host.replace(/^www\./, '').replace(/\.$/, '')
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null
  return host
}

/** The host access a site needs (redirecting requires access to the blocked address). */
export function sitePatterns(site: string): string[] {
  return [`*://${site}/*`, `*://*.${site}/*`]
}

export const RULE_BASE = 1000

/** The blocking rules for these sites: their pages open the focus page instead, with the
 *  original address after `#` (for "back to the page" once focus is over). */
export function blockRules(sites: string[], focusPage: string): chrome.declarativeNetRequest.Rule[] {
  return sites.map((site, i) => ({
    id: RULE_BASE + i,
    priority: 1,
    action: { type: 'redirect' as chrome.declarativeNetRequest.RuleActionType, redirect: { regexSubstitution: `${focusPage}#\\0` } },
    condition: { requestDomains: [site], regexFilter: '^.*$', resourceTypes: ['main_frame' as chrome.declarativeNetRequest.ResourceType] },
  }))
}
