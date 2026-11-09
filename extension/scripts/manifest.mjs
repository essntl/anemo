// @ts-check
/**
 * The manifest of each build, from manifest.json:
 *
 *   normal            no browser control: nothing about the debugger (no install warning)
 *   browser-control   "Anemo Companion (browser control)": the debugger from install, since
 *                     Chrome doesn't offer it as an optional permission. Meant for a separate
 *                     Chrome profile. Tabs, tab groups and all sites are still asked for when
 *                     browser control is switched on.
 *   e2e               the browser-control build for the Playwright tests, which may reach the
 *                     local test sites without Chrome's prompts (automation can't click them)
 */

/**
 * @param {Record<string, any>} base manifest.json
 * @param {{ flavor: 'normal' | 'browser-control' | 'e2e', version: string }} opts
 */
export function manifestFor(base, { flavor, version }) {
  /** @type {Record<string, any>} */
  const m = structuredClone(base)
  m.version = version
  if (flavor === 'normal') {
    // Browser control isn't in this build: none of its permissions are asked for.
    m.optional_permissions = (m.optional_permissions ?? []).filter((/** @type {string} */ p) => !['tabs', 'tabGroups'].includes(p))
    return m
  }
  m.name = `${base.name} (browser control)`
  m.permissions = [...m.permissions, 'debugger']
  if (flavor === 'e2e') {
    m.host_permissions = ['http://127.0.0.1/*', 'https://www.youtube.com/*', '*://distraction.test/*', '*://*.distraction.test/*', 'http://localhost/*']
    m.permissions = [...m.permissions, 'declarativeNetRequestWithHostAccess', 'tabGroups']
  }
  return m
}
