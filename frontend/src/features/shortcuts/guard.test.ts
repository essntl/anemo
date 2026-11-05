/**
 * Keeps the shortcut sheet honest: keys are handled through the registry, so a new
 * shortcut has to be listed there to work at all.
 */
const sources = import.meta.glob(['/src/**/*.{ts,tsx}', '!/src/**/*.test.{ts,tsx}'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>

/** Files that listen to every key press for something that isn't a shortcut of its own. */
const GLOBAL_KEY_LISTENERS: Record<string, string> = {
  '/src/hooks/useShortcut.ts': 'the shortcut engine itself',
  '/src/hooks/useShiftHeld.ts': 'Shift held over the chat list (chat.quickDelete)',
  '/src/features/island/Island.tsx': 'Esc closes the expanded Island (app.close)',
  '/src/features/chat/tab.ts': 'notices that the tab is in use; not a shortcut',
}

describe('shortcuts go through the registry', () => {
  it('found the source files', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(50)
  })

  it('has no keydown listener on window or document outside the known files', () => {
    const offenders = Object.entries(sources)
      .filter(([, text]) => /(window|document)\.addEventListener\(\s*['"]keydown['"]/.test(text))
      .map(([file]) => file)
      .filter((file) => !(file in GLOBAL_KEY_LISTENERS))
    expect(offenders, 'Add the shortcut to features/shortcuts/registry.ts and use useShortcut()').toEqual([])
  })

  it('no longer has the old match-function hotkey hook', () => {
    const offenders = Object.entries(sources).filter(([, text]) => /\buseHotkey\s*\(/.test(text)).map(([file]) => file)
    expect(offenders).toEqual([])
  })

  it('only uses shortcut ids that exist', async () => {
    const { SHORTCUTS } = await import('./registry')
    const used = Object.values(sources).flatMap((text) => [...text.matchAll(/useShortcut\(\s*'([\w.]+)'/g)].map((m) => m[1]))
    expect(used.length).toBeGreaterThan(5)
    for (const id of used) expect(SHORTCUTS, id).toHaveProperty([id])
  })
})
