/**
 * The server's clock, as seen from this browser.
 *
 * Times the server recorded (when an answer started, since when it waits) are compared
 * with `serverNow()`, never with `Date.now()`: the browser's clock can be off by
 * seconds or minutes, and a reload, a second tab or another device must show the same
 * time. Every API response carries the server's time in `X-Server-Time` (milliseconds
 * since the epoch); api/client.ts hands each response to `noteServerTime`.
 */

export const SERVER_TIME_HEADER = 'X-Server-Time'

/** How far the server's clock is ahead of this browser's, in milliseconds. */
let offsetMs = 0

/**
 * Learn the clock difference from a response. `sentAt` is when the request left (the
 * browser's time): the server's time is taken as the middle of the round trip.
 */
export function noteServerTime(response: Response, sentAt?: number, receivedAt = Date.now()): void {
  const server = Number(response.headers.get(SERVER_TIME_HEADER))
  if (!response.headers.has(SERVER_TIME_HEADER) || !Number.isFinite(server)) return
  const local = sentAt !== undefined && sentAt <= receivedAt ? (sentAt + receivedAt) / 2 : receivedAt
  offsetMs = server - local
}

/** The server's time now, in milliseconds since the epoch. */
export function serverNow(): number {
  return Date.now() + offsetMs
}
