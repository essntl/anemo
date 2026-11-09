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
  /** True in the build with browser control (dist-browser/, and the Playwright build). */
  const __BROWSER_CONTROL__: boolean
}

export const DEV = typeof __DEV__ !== 'undefined' && __DEV__
export const E2E = typeof __E2E__ !== 'undefined' && __E2E__
/** Browser control is in this build (it holds the debugger permission). */
export const BROWSER_CONTROL = typeof __BROWSER_CONTROL__ !== 'undefined' && __BROWSER_CONTROL__

export const log = {
  debug(message: string, ctx?: Record<string, unknown>): void {
    if (DEV) console.debug(`[anemo] ${message}`, ctx ?? '')
  },
  warn(message: string, ctx?: Record<string, unknown>): void {
    console.warn(`[anemo] ${message}`, ctx ?? '')
  },
}
