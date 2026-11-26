import { describe, expect, it } from 'vitest'
import { DEFAULT_APPEARANCE } from './apply'
import { exportJson, ImportError, parseImport } from './transfer'

const FONT = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
const PICTURE = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c'

describe('export and import', () => {
  it('round-trips', () => {
    const look = {
      ...DEFAULT_APPEARANCE,
      mode: 'dark' as const,
      accent: '#e0457b',
      tint: '#336699',
      ui_font: `custom:${FONT}`,
      background: { ...DEFAULT_APPEARANCE.background, kind: 'upload' as const, asset_id: PICTURE, blur: 12 },
      glass: true,
    }
    expect(parseImport(exportJson(look), [FONT, PICTURE])).toEqual(look)
  })

  it('carries a custom gradient and the glass strength, and checks them', () => {
    const custom = { colors: ['#111111', '#abcdef'], style: 'linear' as const, angle: 45, speed: 'fast' as const }
    const look = {
      ...DEFAULT_APPEARANCE,
      background: { ...DEFAULT_APPEARANCE.background, kind: 'gradient' as const, gradient: 'custom' as const, custom_gradient: custom },
      glass: true,
      glass_strength: 80,
    }
    expect(parseImport(exportJson(look), [])).toEqual(look)

    const bad = JSON.parse(exportJson(look))
    bad.appearance.background.custom_gradient = { colors: ['#111111', 'url(x)'], style: 'spiral', angle: 900, speed: 'warp' }
    bad.appearance.glass_strength = 500
    const imported = parseImport(JSON.stringify(bad), [])
    expect(imported.background.custom_gradient).toEqual({ colors: DEFAULT_APPEARANCE.background.custom_gradient.colors, style: 'drift', angle: 359, speed: 'normal' })
    expect(imported.glass_strength).toBe(100)
  })

  it('drops uploads this server does not have', () => {
    const look = {
      ...DEFAULT_APPEARANCE,
      code_font: `custom:${FONT}`,
      background: { ...DEFAULT_APPEARANCE.background, kind: 'upload' as const, asset_id: PICTURE },
    }
    const imported = parseImport(exportJson(look), [])
    expect(imported.code_font).toBe('default')
    expect(imported.background.kind).toBe('none')
    expect(imported.background.asset_id).toBeNull()
  })

  it('replaces values that are not allowed', () => {
    const text = JSON.stringify({
      format: 'anemo.appearance',
      version: 1,
      appearance: { accent: 'url(javascript:x)', mode: 'neon', ui_font: 'Comic Sans', tint_strength: 900, background: { blur: -4, fit: 'stretch' } },
    })
    const a = parseImport(text, [])
    expect(a.accent).toBe(DEFAULT_APPEARANCE.accent)
    expect(a.mode).toBe('system')
    expect(a.ui_font).toBe('default')
    expect(a.tint_strength).toBe(100)
    expect(a.background.blur).toBe(0)
    expect(a.background.fit).toBe('cover')
  })

  it('refuses files that are not appearance files', () => {
    expect(() => parseImport('not json', [])).toThrow(ImportError)
    expect(() => parseImport('{"appearance": {}}', [])).toThrow(ImportError)
  })
})
