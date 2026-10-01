import { describe, expect, it } from 'vitest'
import { inputForKey, mergeInputs, pagePoint } from './input'

const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mods,
})

describe('browser panel input', () => {
  it('converts a click on the scaled picture to the browser’s own pixels', () => {
    const page = { width: 1280, height: 800 }
    // The picture is shown at half size, 100px from the left and 50px from the top.
    const box = { left: 100, top: 50, width: 640, height: 400 }
    expect(pagePoint(box, 100, 50, page)).toEqual({ x: 0, y: 0 })
    expect(pagePoint(box, 420, 250, page)).toEqual({ x: 640, y: 400 })
    expect(pagePoint(box, 740, 450, page)).toEqual({ x: 1280, y: 800 })
    // Positions just outside the picture are pulled back onto it.
    expect(pagePoint(box, 20, 9999, page)).toEqual({ x: 0, y: 800 })
  })

  it('passes on characters, special keys and select-all', () => {
    expect(inputForKey(key('a'))).toEqual({ kind: 'type', text: 'a' })
    expect(inputForKey(key(' '))).toEqual({ kind: 'type', text: ' ' })
    expect(inputForKey(key('Enter'))).toEqual({ kind: 'key', key: 'Enter' })
    expect(inputForKey(key('ArrowDown'))).toEqual({ kind: 'key', key: 'ArrowDown' })
    expect(inputForKey(key('a', { ctrlKey: true }))).toEqual({ kind: 'key', key: 'Control+a' })
    expect(inputForKey(key('A', { metaKey: true }))).toEqual({ kind: 'key', key: 'Control+a' })
  })

  it('leaves shortcuts and modifier keys to this browser', () => {
    expect(inputForKey(key('v', { ctrlKey: true }))).toBeNull() // paste arrives as a paste event
    expect(inputForKey(key('r', { ctrlKey: true }))).toBeNull()
    expect(inputForKey(key('Shift'))).toBeNull()
    expect(inputForKey(key('F5'))).toBeNull()
    expect(inputForKey(key('x', { altKey: true }))).toBeNull()
  })

  it('joins quick typing and scrolling, keeping the order of everything else', () => {
    expect(
      mergeInputs([
        { kind: 'type', text: 'h' },
        { kind: 'type', text: 'i' },
        { kind: 'key', key: 'Enter' },
        { kind: 'type', text: '!' },
        { kind: 'scroll', dy: 100, x: 1, y: 1 },
        { kind: 'scroll', dy: 150, x: 5, y: 6 },
        { kind: 'click', x: 3, y: 4 },
      ]),
    ).toEqual([
      { kind: 'type', text: 'hi' },
      { kind: 'key', key: 'Enter' },
      { kind: 'type', text: '!' },
      { kind: 'scroll', dy: 250, x: 5, y: 6 },
      { kind: 'click', x: 3, y: 4 },
    ])
  })
})
