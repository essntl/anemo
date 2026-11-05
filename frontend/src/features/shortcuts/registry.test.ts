import { AREAS, comboLabels, matchesShortcut, sheetSections, SHORTCUTS, shortcutText, type Shortcut } from './registry'

const press = (key: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({
  key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods,
})
const all = Object.entries(SHORTCUTS) as [string, Shortcut][]

describe('shortcut registry', () => {
  it('has a description, a known area and at least one shown key for every entry', () => {
    const areas = new Set(AREAS.map((a) => a.id))
    for (const [id, s] of all) {
      expect(s.description, id).toBeTruthy()
      expect(areas.has(s.area), id).toBe(true)
      expect(s.keys.some((k) => !k.quiet), id).toBe(true)
    }
  })

  it('does not give the same keys two meanings in one area', () => {
    const seen = new Map<string, string>()
    for (const [id, s] of all) {
      for (const k of s.keys) {
        const sig = `${s.area}:${k.mod ? 'mod+' : ''}${k.alt ? 'alt+' : ''}${k.shift === undefined ? '' : `shift=${k.shift}+`}${k.key.toLowerCase()}`
        // Esc means "stop editing" on Home and "close" everywhere: different areas, fine.
        expect(seen.get(sig), `${id} and ${seen.get(sig)} share ${sig}`).toBeUndefined()
        seen.set(sig, id)
      }
    }
  })

  it('matches keys with the right modifiers only', () => {
    expect(matchesShortcut(SHORTCUTS['app.search'], press('k', { ctrlKey: true }))).toBe(true)
    expect(matchesShortcut(SHORTCUTS['app.search'], press('K', { metaKey: true }))).toBe(true)
    expect(matchesShortcut(SHORTCUTS['app.search'], press('k'))).toBe(false)
    expect(matchesShortcut(SHORTCUTS['app.search'], press('k', { ctrlKey: true, altKey: true }))).toBe(false)
    expect(matchesShortcut(SHORTCUTS['focus.reset'], press('r'))).toBe(true)
    expect(matchesShortcut(SHORTCUTS['focus.reset'], press('r', { ctrlKey: true }))).toBe(false)
    expect(matchesShortcut(SHORTCUTS['focus.addMinute'], press('='))).toBe(true)
    // ? comes with Shift on most layouts: Shift is not required either way.
    expect(matchesShortcut(SHORTCUTS['app.shortcuts'], press('?', { shiftKey: true }))).toBe(true)
    expect(matchesShortcut(SHORTCUTS['chat.send'], press('Enter'))).toBe(true)
    expect(matchesShortcut(SHORTCUTS['chat.send'], press('Enter', { ctrlKey: true }))).toBe(true)
    expect(matchesShortcut(SHORTCUTS['chat.send'], press('Enter', { shiftKey: true }))).toBe(false)
    expect(matchesShortcut(SHORTCUTS['home.resize'], press('ArrowLeft', { shiftKey: true }))).toBe(true)
    expect(matchesShortcut(SHORTCUTS['home.move'], press('ArrowLeft', { shiftKey: true }))).toBe(false)
  })

  it('shows Ctrl and Alt, or ⌘ and ⌥ on Apple devices', () => {
    expect(comboLabels({ key: 'k', mod: true }, false)).toEqual(['Ctrl', 'K'])
    expect(comboLabels({ key: 'k', mod: true }, true)).toEqual(['⌘', 'K'])
    expect(comboLabels({ key: 'x', alt: true, shift: true }, true)).toEqual(['⌥', '⇧', 'X'])
    expect(comboLabels({ key: ' ' }, false)).toEqual(['Space'])
    expect(comboLabels({ key: 'Escape' }, false)).toEqual(['Esc'])
    expect(shortcutText('app.sidebar', false)).toBe('Ctrl+\\')
    expect(shortcutText('app.search', true)).toBe('⌘K')
  })

  it('lists the page you are on first, then Everywhere', () => {
    expect(sheetSections('/focus').map((s) => s.area.id).slice(0, 2)).toEqual(['focus', 'everywhere'])
    expect(sheetSections('/c/123')[0].area.id).toBe('chat')
    expect(sheetSections('/calendar')[0].area.id).toBe('everywhere')
    // Every entry appears exactly once.
    expect(sheetSections('/').flatMap((s) => s.shortcuts.map((x) => x.id)).sort()).toEqual(Object.keys(SHORTCUTS).sort())
  })
})
