import { applyAppearance, contrastText } from './theme'

describe('contrastText', () => {
  it('uses white text on dark accents and dark text on light accents', () => {
    expect(contrastText('#3478f6')).toBe('#ffffff')
    expect(contrastText('#1a1a1a')).toBe('#ffffff')
    expect(contrastText('#ffe066')).toBe('#111111')
  })

  it('falls back to white for invalid input', () => {
    expect(contrastText('not-a-color')).toBe('#ffffff')
  })
})

describe('applyAppearance', () => {
  it('writes theme, density and accent variables to <html>', () => {
    applyAppearance({ mode: 'dark', accent: '#e0457b', density: 'compact' })
    const root = document.documentElement
    expect(root.dataset.theme).toBe('dark')
    expect(root.dataset.density).toBe('compact')
    expect(root.style.getPropertyValue('--accent')).toBe('#e0457b')
  })
})
