/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contrast } from '@/lib/color'
import { applyLook, BASE, contrastWarnings, cssVariables, DEFAULT_APPEARANCE, glassLook, lookFor, withDefaults } from './apply'

// Read from disk: with `css: false` (vite.config.ts) even a `?raw` CSS import is empty in tests.
const tokens = readFileSync(join(process.cwd(), 'src/styles/tokens.css'), 'utf8')

/** `--name: value;` of the first block that starts with `selector {`. */
function tokenBlock(selector: string): Record<string, string> {
  const start = tokens.indexOf(`${selector} {`)
  const body = tokens.slice(start, tokens.indexOf('}', start))
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))
}

describe('the copy of the theme colours', () => {
  it.each([['light', ':root'], ['dark', "[data-theme='dark']"]] as const)('matches tokens.css (%s)', (mode, selector) => {
    const css = tokenBlock(selector)
    for (const [name, value] of Object.entries(BASE[mode])) expect(css[`--${name}`], name).toBe(value)
  })
})

describe('cssVariables', () => {
  it('sets the accent and its shades, and nothing else by default', () => {
    const vars = cssVariables(DEFAULT_APPEARANCE, 'light')
    expect(Object.keys(vars).sort()).toEqual(['--accent', '--accent-active', '--accent-contrast', '--accent-hover'])
    expect(vars['--accent']).toBe('#2a6df4')
    expect(vars['--accent-contrast']).toBe('#ffffff')
  })

  it('picks dark text on a light accent', () => {
    expect(cssVariables({ ...DEFAULT_APPEARANCE, accent: '#ffe14d' }, 'light')['--accent-contrast']).toBe('#111111')
  })

  it('never passes an invalid colour on to CSS', () => {
    const vars = cssVariables({ ...DEFAULT_APPEARANCE, accent: 'red; background: url(x)' }, 'light')
    expect(vars['--accent']).toBe('#2a6df4')
  })

  it('tints the surfaces, the page most', () => {
    const tinted = { ...DEFAULT_APPEARANCE, tint: '#ff0000', tint_strength: 100 }
    const vars = cssVariables(tinted, 'light')
    expect(vars['--bg']).not.toBe(BASE.light.bg)
    // The page moves further from its own colour than the cards do.
    const moved = (name: 'bg' | 'card') => contrast(vars[`--${name}`], BASE.light[name])
    expect(moved('bg')).toBeGreaterThan(moved('card'))
    expect(cssVariables({ ...tinted, tint_strength: 0 }, 'light')['--bg']).toBeUndefined()
  })

  it('sets the fonts that are not the default', () => {
    const vars = cssVariables({ ...DEFAULT_APPEARANCE, ui_font: 'inter', code_font: 'default' }, 'light')
    expect(vars['--font-ui']).toContain("'Inter Variable'")
    expect(vars['--font-code']).toBeUndefined()
  })
})

describe('contrastWarnings', () => {
  it('has nothing to say about the defaults', () => {
    expect(contrastWarnings(DEFAULT_APPEARANCE, 'light')).toEqual([])
    expect(contrastWarnings(DEFAULT_APPEARANCE, 'dark')).toEqual([])
  })

  it('warns about an accent that vanishes on the page', () => {
    const kinds = contrastWarnings({ ...DEFAULT_APPEARANCE, accent: '#f0f0f0' }, 'light').map((w) => w.kind)
    expect(kinds).toContain('accent-page')
  })

  it('warns about buttons whose text is hard to read', () => {
    const [warning] = contrastWarnings({ ...DEFAULT_APPEARANCE, accent: '#7a7a7a' }, 'light')
    expect(warning.kind).toBe('accent-text')
    expect(warning.ratio).toBeLessThan(warning.needed)
  })

  it('warns about a strong dark tint in light mode', () => {
    const kinds = contrastWarnings({ ...DEFAULT_APPEARANCE, tint: '#000000', tint_strength: 100 }, 'light').map((w) => w.kind)
    expect(kinds).toContain('text-surface')
  })
})

describe('applying a look', () => {
  it('writes the variables of the mode and removes ones no longer set', () => {
    const root = document.createElement('div')
    applyLook(lookFor({ ...DEFAULT_APPEARANCE, tint: '#336699', glass: true }), 'dark', root)
    expect(root.dataset.theme).toBe('dark')
    expect(root.dataset.glass).toBe('on')
    expect(root.dataset.background).toBe('off')
    expect(root.style.getPropertyValue('--bg')).not.toBe('')
    applyLook(lookFor(DEFAULT_APPEARANCE), 'light', root)
    expect(root.style.getPropertyValue('--bg')).toBe('')
    expect(root.dataset.glass).toBe('off')
  })

  it('fills in what an older value leaves out', () => {
    const a = withDefaults({ mode: 'dark', accent: '#e0457b', density: 'compact' })
    expect(a.background.kind).toBe('none')
    expect(a.tint).toBeNull()
    expect(withDefaults({ background: { kind: 'gradient' } as never }).background.dim).toBe(35)
  })
})

describe('frosted glass strength', () => {
  it('looks as it always did at the default strength', () => {
    expect(glassLook(50, 'light')).toEqual({ blur: 18, opacity: 72 })
    expect(glassLook(50, 'dark')).toEqual({ blur: 18, opacity: 66 })
  })

  it('never lets a panel get more see-through than 70 % (65 % in dark)', () => {
    for (let s = 0; s <= 100; s += 5) {
      expect(glassLook(s, 'light').opacity).toBeGreaterThanOrEqual(70)
      expect(glassLook(s, 'dark').opacity).toBeGreaterThanOrEqual(65)
    }
    expect(glassLook(0, 'light').blur).toBeLessThan(glassLook(100, 'light').blur)
  })

  it('sets the glass variables only while glass is on', () => {
    expect(cssVariables({ ...DEFAULT_APPEARANCE, glass: false, glass_strength: 90 }, 'light')['--glass-blur']).toBeUndefined()
    const vars = cssVariables({ ...DEFAULT_APPEARANCE, glass: true, glass_strength: 100 }, 'dark')
    expect(vars['--glass-blur']).toBe('32px')
    expect(vars['--glass-opacity']).toBe('65%')
  })
})

describe('density', () => {
  /** Every `--name:` set inside the blocks for `selector` (there may be several, in media queries). */
  function declared(selector: string): Set<string> {
    const names = new Set<string>()
    for (let at = tokens.indexOf(`${selector} {`); at !== -1; at = tokens.indexOf(`${selector} {`, at + 1)) {
      const body = tokens.slice(at, tokens.indexOf('}', at))
      for (const m of body.matchAll(/(--[\w-]+):/g)) names.add(m[1])
    }
    return names
  }

  it('has a compact value for every spacing token', () => {
    const spacing = ['--nav-row-h', '--list-row-y', '--row-y', '--card-x', '--card-y', '--card-gap', '--item-x', '--item-y', '--stack-gap', '--item-gap', '--msg-gap', '--btn-h', '--btn-sm-h']
    const compact = declared("[data-density='compact']")
    for (const name of spacing) {
      expect(tokens, name).toContain(`${name}:`)
      expect(compact.has(name), name).toBe(true)
    }
  })

  it('is switched on <html>, before the first paint too', () => {
    const root = document.createElement('html')
    applyLook(lookFor({ ...DEFAULT_APPEARANCE, density: 'compact' }), 'light', root)
    expect(root.dataset.density).toBe('compact')
    applyLook(lookFor(DEFAULT_APPEARANCE), 'light', root)
    expect(root.dataset.density).toBe('comfortable')
  })
})
