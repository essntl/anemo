import { describe, expect, it } from 'vitest'
import { LIST_MAX, placeMenu } from './menuPlacement'

const area = { top: 0, bottom: 800 }
const CHROME = 80 // heading and "Manage skills"

describe('placeMenu', () => {
  it('opens above the box when the menu fits there', () => {
    // The box at the bottom of a conversation.
    expect(placeMenu({ top: 650, bottom: 780 }, area, CHROME, 500)).toEqual({ below: false, listMax: LIST_MAX })
  })

  it('opens below the box when it is near the top and there is more room underneath', () => {
    // The box on the new chat screen, under the heading.
    expect(placeMenu({ top: 200, bottom: 320 }, area, CHROME, 500)).toEqual({ below: true, listMax: LIST_MAX })
  })

  it('makes the list shorter where neither side has room for all of it', () => {
    // A short window: 300 px above the box (284 without the gap and margin), 34 below.
    const { below, listMax } = placeMenu({ top: 300, bottom: 400 }, { top: 0, bottom: 450 }, CHROME, 500)
    expect(below).toBe(false)
    expect(listMax).toBe(284 - CHROME)
  })

  it('counts from the top of what can be seen, not of the window', () => {
    // Room enough above in the window, but the page's own area starts lower down.
    expect(placeMenu({ top: 400, bottom: 500 }, { top: 100, bottom: 1000 }, CHROME, 500).below).toBe(true)
  })

  it('stays above when only a few skills match and they fit', () => {
    const { below, listMax } = placeMenu({ top: 200, bottom: 320 }, area, CHROME, 100)
    expect(below).toBe(false)
    expect(listMax).toBeGreaterThanOrEqual(100)
  })

  it('keeps a couple of skills in sight however little room there is', () => {
    expect(placeMenu({ top: 50, bottom: 750 }, area, CHROME, 500).listMax).toBe(96)
  })
})
