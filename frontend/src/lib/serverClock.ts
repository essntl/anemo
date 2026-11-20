/**
 * The server's clock, as seen from this browser.
 *
 * Times the server recorded (when an answer started, since when it waits) are compared
 * with `serverNow()`, never with `Date.now()`: the browser's clock can be off by
 * seconds or minutes, and a reload, a second tab or another device must show the same
 * time. Every API response carries the server's time in `X-Server-Time` (milliseconds
 * since the epoch); api/client.ts hands each response to `noteServerTime`.
 *
 * The server stamps its time when the answer starts to go out, after its work, so the
 * stamp is closest to the moment the answer arrives: the offset is taken from that. It
 * is off by at most the round trip, so the answer with the shortest round trip is
 * trusted most; after a while a newer one replaces it, in case either clock changed.
 */

export const SERVER_TIME_HEADER = 'X-Server-Time'

/** How long the best sample is kept before any newer one may replace it. */
const SAMPLE_LIFETIME_MS = 10 * 60_000

interface Sample {
  offsetMs: number // how far the server's clock is ahead of this browser's
  roundTripMs: number // Infinity: not known
  at: number // when it was taken (browser time)
}

let best: Sample | null = null

/**
 * Learn the clock difference from a response that arrived at `receivedAt` (browser
 * time). `sentAt` is when its request left: the shorter the trip, the better the sample.
 */
export function noteServerTime(response: Response, sentAt?: number, receivedAt = Date.now()): void {
  const header = response.headers.get(SERVER_TIME_HEADER)
  const server = header === null ? NaN : Number(header)
  if (!Number.isFinite(server)) return
  const roundTripMs = sentAt !== undefined && sentAt <= receivedAt ? receivedAt - sentAt : Infinity
  const sample = { offsetMs: server - receivedAt, roundTripMs, at: receivedAt }
  if (!best || roundTripMs <= best.roundTripMs || receivedAt - best.at > SAMPLE_LIFETIME_MS) best = sample
}

/** The server's time now, in milliseconds since the epoch. */
export function serverNow(): number {
  return Date.now() + (best?.offsetMs ?? 0)
}

/** Forget what was learned (tests). */
export function resetServerClock(): void {
  best = null
}
