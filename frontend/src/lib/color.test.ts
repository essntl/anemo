import { describe, expect, it } from 'vitest'
import { accentShades, bestTextOn, contrast, isHex, luminance, mix, parseHex, toHex } from './color'

describe('parsing', () => {
  it('reads 6-digit hex colours, with or without #', () => {
    expect(parseHex('#2a6df4')).toEqual({ r: 42, g: 109, b: 244 })
    expect(parseHex('FFFFFF')).toEqual({ r: 255, g: 255, b: 255 })
    expect(toHex({ r: 42, g: 109, b: 244 })).toBe('#2a6df4')
  })

  it('refuses anything else', () => {
    for (const bad of ['red', '#fff', '#12345g', 'url(x)', '', '#2a6df4; color: red']) {
      expect(isHex(bad)).toBe(false)
    }
  })
})

describe('WCAG contrast', () => {
  it('matches the reference values', () => {
    expect(luminance('#000000')).toBe(0)
    expect(luminance('#ffffff')).toBeCloseTo(1)
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21)
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1)
    // #767676 on white is the classic "just passes AA" grey.
    expect(contrast('#767676', '#ffffff')).toBeCloseTo(4.54, 1)
  })

  it('is symmetric', () => {
    expect(contrast('#2a6df4', '#eceef2')).toBeCloseTo(contrast('#eceef2', '#2a6df4'))
  })
})

describe('mixing in OKLab', () => {
  it('goes from one colour to the other', () => {
    expect(mix('#2a6df4', '#000000', 0)).toBe('#2a6df4')
    expect(mix('#2a6df4', '#000000', 1)).toBe('#000000')
    expect(luminance(mix('#2a6df4', '#000000', 0.12))).toBeLessThan(luminance('#2a6df4'))
    expect(luminance(mix('#2a6df4', '#ffffff', 0.12))).toBeGreaterThan(luminance('#2a6df4'))
  })

  it('leaves invalid input alone', () => {
    expect(mix('nope', '#000000', 0.5)).toBe('nope')
  })
})

describe('text on the accent', () => {
  it('picks white on dark colours and black on light ones', () => {
    expect(bestTextOn(['#1b3a8a']).color).toBe('#ffffff')
    expect(bestTextOn(['#ffe14d']).color).toBe('#111111')
  })

  it('checks every background it will be shown on', () => {
    const { ratio } = bestTextOn(['#ffffff', '#000000'])
    expect(ratio).toBeLessThan(4.6) // no colour reads well on both
  })

  it('derives darker shades in light mode and lighter ones in dark mode', () => {
    const light = accentShades('#2a6df4', false)
    expect(luminance(light.hover)).toBeLessThan(luminance('#2a6df4'))
    expect(luminance(light.active)).toBeLessThan(luminance(light.hover))
    const dark = accentShades('#2a6df4', true)
    expect(luminance(dark.hover)).toBeGreaterThan(luminance('#2a6df4'))
    expect(light.contrastText).toBe('#ffffff')
    expect(light.textRatio).toBeGreaterThanOrEqual(4.5)
  })

  it('reports a ratio under AA for a mid-tone accent', () => {
    // Mid grey: neither black nor white reaches 4.5:1 on it (both are about 4.3:1).
    const s = accentShades('#7a7a7a', false)
    expect(s.textRatio).toBeLessThan(4.5)
  })
})
