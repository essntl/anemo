import { describe, expect, it } from 'vitest'
import { doublePressDetector } from './useShortcut'

/** A key event as the browser sends it; `lock` is what getModifierState('CapsLock') says. */
const ev = (type: 'keydown' | 'keyup', timeStamp: number, lock = false, key = 'CapsLock', repeat = false) => ({
  type, key, repeat, timeStamp, getModifierState: (k: string) => k === 'CapsLock' && lock,
})

describe('double press', () => {
  it('sees two Caps Lock presses as on Windows and Linux (down and up for each)', () => {
    const detect = doublePressDetector()
    const fired = [
      ev('keydown', 0, true), ev('keyup', 80, true), // on
      ev('keydown', 200, false), ev('keyup', 270, false), // off again
    ].map(detect)
    expect(fired).toEqual([false, false, true, false])
  })

  it('sees two Caps Lock presses as on a Mac (down when it turns on, up when it turns off)', () => {
    const detect = doublePressDetector()
    expect([ev('keydown', 0, true), ev('keyup', 220, false)].map(detect)).toEqual([false, true])
    expect([ev('keydown', 5000, true), ev('keyup', 5200, false)].map(detect)).toEqual([false, true])
    // With Caps Lock on when the page opened: up (off), then down (on).
    const fromOn = doublePressDetector()
    expect([ev('keyup', 0, false), ev('keydown', 200, true)].map(fromOn)).toEqual([false, true])
  })

  it('ignores presses too far apart, held keys and other keys', () => {
    const detect = doublePressDetector(500)
    expect([ev('keydown', 0, true), ev('keydown', 900, false)].map(detect)).toEqual([false, false])
    const held = doublePressDetector()
    expect([ev('keydown', 0, true), ev('keydown', 40, true, 'CapsLock', true)].map(held)).toEqual([false, false])
  })

  it('starts a new pair after a double press', () => {
    const detect = doublePressDetector()
    const fired = [ev('keydown', 0, true), ev('keydown', 150, false), ev('keydown', 300, true), ev('keydown', 450, false)].map(detect)
    expect(fired).toEqual([false, true, false, true])
  })

  it('counts key-downs for keys without an on/off state', () => {
    const detect = doublePressDetector()
    const fired = [ev('keydown', 0, false, 'Shift'), ev('keyup', 60, false, 'Shift'), ev('keydown', 200, false, 'Shift')].map(detect)
    expect(fired).toEqual([false, false, true])
  })
})
