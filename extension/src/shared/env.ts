/**
 * Build-time flags and the one logger.
 *
 * `__DEV__` is true only in `npm run dev` builds. Production builds drop debug output, and
 * nothing here ever logs tokens or page content: pass ids and sizes, not texts.
 */
declare global {
  const __DEV__: boolean
}

export const DEV = typeof __DEV__ !== 'undefined' && __DEV__

export const log = {
  debug(message: string, ctx?: Record<string, unknown>): void {
    if (DEV) console.debug(`[anemo] ${message}`, ctx ?? '')
  },
  warn(message: string, ctx?: Record<string, unknown>): void {
    console.warn(`[anemo] ${message}`, ctx ?? '')
  },
}
