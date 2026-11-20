/**
 * How long an answer took, from the server's record (MessageOut.timing).
 *
 * The server is the clock: an answer starts when the server accepted the message, and
 * the time it waited for you (an approval, a question, a pause) is not part of how long
 * it took. While it runs, its live stream reports each change of that waiting time
 * ("run.timing"), so a running timer stops while it waits and goes on after.
 */
import type { Schemas } from '@/api/client'

export type RunTiming = Schemas['RunTiming']

/** What the "run.timing" event says: how long the run has waited for you so far. */
export interface Waiting {
  waiting_ms: number
  waiting_since: string | null
}

/** The answer's timing with the newest waiting time from its live stream. */
export function withWaiting(timing: RunTiming, waiting: Waiting | null): RunTiming {
  return waiting ? { ...timing, ...waiting } : timing
}

/** How long a finished answer took, in milliseconds (null while it runs). */
export function durationMs(timing: RunTiming): number | null {
  if (!timing.finished_at) return null
  return Math.max(Date.parse(timing.finished_at) - Date.parse(timing.started_at) - timing.waiting_ms, 0)
}

/** How long it took until the first text of the answer arrived, without the time it
 *  waited for you before that (null: no text). */
export function firstTextMs(timing: RunTiming): number | null {
  if (!timing.first_text_at) return null
  const waited = timing.first_text_waiting_ms
  return Math.max(Date.parse(timing.first_text_at) - Date.parse(timing.started_at) - waited, 0)
}

/** The time it waited for you in all, up to `now` (the server's time) if it waits now. */
export function waitedMs(timing: RunTiming, now: number): number {
  const current = timing.waiting_since ? Math.max(now - Date.parse(timing.waiting_since), 0) : 0
  return timing.waiting_ms + current
}

/** How long it worked until it started waiting for you (the timer stands still at that). */
export function workedUntilWaitingMs(timing: RunTiming): number {
  if (!timing.waiting_since) return 0
  return Math.max(Date.parse(timing.waiting_since) - Date.parse(timing.started_at) - timing.waiting_ms, 0)
}
