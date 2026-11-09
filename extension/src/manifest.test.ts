import { describe, expect, it } from 'vitest'
import manifest from '../manifest.json'
import { manifestFor } from '../scripts/manifest.mjs'
import { FEATURE_PERMISSIONS } from './shared/permissions'

/** Chrome ignores these in optional_permissions (and asking for them then fails). */
const NEVER_OPTIONAL = ['debugger', 'declarativeNetRequest', 'devtools', 'experimental', 'geolocation', 'mdns', 'proxy', 'tts', 'ttsEngine', 'wallpaper']

const built = (flavor: 'normal' | 'browser-control' | 'e2e') => manifestFor(manifest, { flavor, version: '1.2.3' }) as { name: string; version: string; permissions: string[]; optional_permissions: string[] }

describe('manifest', () => {
  it('no build lists a permission as optional that Chrome only takes as required', () => {
    for (const flavor of ['normal', 'browser-control', 'e2e'] as const) {
      expect(built(flavor).optional_permissions.filter((p) => NEVER_OPTIONAL.includes(p)), flavor).toEqual([])
    }
  })

  it('the normal build has nothing of browser control; its own build has the debugger from install', () => {
    const normal = built('normal')
    expect(normal.name).toBe('Anemo Companion')
    expect(normal.version).toBe('1.2.3')
    expect([...normal.permissions, ...normal.optional_permissions]).not.toEqual(expect.arrayContaining(['debugger']))
    expect(normal.optional_permissions).not.toContain('tabs')
    const browser = built('browser-control')
    expect(browser.name).toBe('Anemo Companion (browser control)')
    expect(browser.permissions).toContain('debugger')
    expect(browser.optional_permissions).toEqual(expect.arrayContaining(['tabs', 'tabGroups']))
  })

  it('every permission a feature asks for is in the build that has the feature', () => {
    for (const [feature, wanted] of Object.entries(FEATURE_PERMISSIONS)) {
      const m = built(feature === 'browserControl' ? 'browser-control' : 'normal')
      const declared = new Set([...m.permissions, ...m.optional_permissions])
      for (const p of wanted.permissions ?? []) expect(declared.has(p), `${feature}: ${p}`).toBe(true)
    }
  })
})
