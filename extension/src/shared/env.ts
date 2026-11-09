/**
 * Build-time flags and the one logger.
 *
 * `__DEV__` is true only in `npm run dev` builds. Production builds drop debug output, and
 * nothing here ever logs tokens or page content: pass ids and sizes, not texts.
 */
declare global {
  const __DEV__: boolean
  /** True only in the Playwright build (dist-e2e/). */
  const __E2E__: boolean
}

export const DEV = typeof __DEV__ !== 'undefined' && __DEV__
export const E2E = typeof __E2E__ !== 'undefined' && __E2E__

export const log = {
  debug(message: string, ctx?: Record<string, unknown>): void {
    if (DEV) console.debug(`[anemo] ${message}`, ctx ?? '')
  },
  warn(message: string, ctx?: Record<string, unknown>): void {
    console.warn(`[anemo] ${message}`, ctx ?? '')
  },
}
