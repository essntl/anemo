import { describe, expect, it } from 'vitest'
import { LIGHT_THEME, luminance, resolveColor } from './palette'

const DARK = { ...LIGHT_THEME, ink: '#e8eaee', dark: true }

describe('resolveColor', () => {
  it('draws ink in the theme’s text colour', () => {
    expect(resolveColor('ink', LIGHT_THEME)).toBe(LIGHT_THEME.ink)
    expect(resolveColor('ink', DARK)).toBe('#e8eaee')
  })

  it('keeps colours as they are on a light sheet', () => {
    expect(resolveColor('#2563eb', LIGHT_THEME)).toBe('#2563eb')
  })

  it('draws dark colours lighter on a dark sheet, and leaves light ones', () => {
    const blue = resolveColor('#2563eb', DARK)
    expect(blue).not.toBe('#2563eb')
    expect(luminance(blue)).toBeGreaterThan(luminance('#2563eb'))
    expect(resolveColor('#000000', DARK)).not.toBe('#000000')
    expect(resolveColor('#f5c400', DARK)).toBe('#f5c400')
  })
})
