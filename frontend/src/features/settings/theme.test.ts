import { applyAppearance, contrastText, DEFAULT_APPEARANCE } from './theme'

describe('contrastText', () => {
  it('uses white text on dark accents and dark text on light accents', () => {
    expect(contrastText('#2a6df4')).toBe('#ffffff') // the default: 4.6:1
    // By WCAG contrast, not a brightness cut-off: on this mid blue white has 4.1:1 and
    // near-black 4.6:1 (it used to get white).
    expect(contrastText('#3478f6')).toBe('#111111')
    expect(contrastText('#1a1a1a')).toBe('#ffffff')
    expect(contrastText('#ffe066')).toBe('#111111')
  })

  it('falls back to white for invalid input', () => {
    expect(contrastText('not-a-color')).toBe('#ffffff')
  })
})

describe('applyAppearance', () => {
  it('writes theme, density and accent variables to <html>', () => {
    applyAppearance({ ...DEFAULT_APPEARANCE, mode: 'dark', accent: '#e0457b', density: 'compact' })
    const root = document.documentElement
    expect(root.dataset.theme).toBe('dark')
    expect(root.dataset.density).toBe('compact')
    expect(root.style.getPropertyValue('--accent')).toBe('#e0457b')
  })
})
