import { describe, expect, it } from 'vitest'
import { canPull, dismisses } from './useSheetSwipe'

describe('letting go of a bottom sheet', () => {
  it('puts it away after a pull of a good part of it', () => {
    expect(dismisses({ dy: 130, ms: 900, height: 400 })).toBe(true)
    expect(dismisses({ dy: 100, ms: 900, height: 400 })).toBe(false)
  })

  it('needs no more than 160px on a tall sheet', () => {
    expect(dismisses({ dy: 170, ms: 1500, height: 800 })).toBe(true)
    expect(dismisses({ dy: 150, ms: 1500, height: 800 })).toBe(false)
  })

  it('puts it away on a quick flick, however short', () => {
    expect(dismisses({ dy: 60, ms: 80, height: 600 })).toBe(true)
    // Slow, or barely moved: it slides back.
    expect(dismisses({ dy: 60, ms: 400, height: 600 })).toBe(false)
    expect(dismisses({ dy: 30, ms: 20, height: 600 })).toBe(false)
  })

  it('never on a movement upwards', () => {
    expect(dismisses({ dy: 0, ms: 50, height: 300 })).toBe(false)
    expect(dismisses({ dy: -200, ms: 50, height: 300 })).toBe(false)
  })
})

describe('where a sheet can be pulled from', () => {
  function sheet(inner: string) {
    const el = document.createElement('div')
    el.className = 'sheet'
    el.innerHTML = inner
    document.body.append(el)
    return el
  }

  it('anywhere on it while nothing in it is scrolled', () => {
    const el = sheet('<h2>Title</h2><div class="list"><button>Item</button></div>')
    expect(canPull(el.querySelector('button'), el)).toBe(true)
    expect(canPull(el.querySelector('h2'), el)).toBe(true)
    expect(canPull(el, el)).toBe(true)
  })

  it('not from a list that is scrolled down: the finger scrolls it back first', () => {
    const el = sheet('<h2>Title</h2><div class="list"><button>Item</button></div>')
    el.querySelector('.list')!.scrollTop = 40
    expect(canPull(el.querySelector('button'), el)).toBe(false)
    // The title above the list still pulls it.
    expect(canPull(el.querySelector('h2'), el)).toBe(true)
  })

  it('not while the sheet itself is scrolled', () => {
    const el = sheet('<button>Item</button>')
    el.scrollTop = 10
    expect(canPull(el.querySelector('button'), el)).toBe(false)
  })

  it('not from a text area, a slider or anything marked data-no-swipe', () => {
    const el = sheet('<textarea></textarea><input type="range"><div data-no-swipe><span>map</span></div><input type="text">')
    expect(canPull(el.querySelector('textarea'), el)).toBe(false)
    expect(canPull(el.querySelector('input[type=range]'), el)).toBe(false)
    expect(canPull(el.querySelector('span'), el)).toBe(false)
    expect(canPull(el.querySelector('input[type=text]'), el)).toBe(true)
  })

  it('not from outside the sheet', () => {
    const el = sheet('<button>Item</button>')
    const outside = document.createElement('button')
    document.body.append(outside)
    expect(canPull(outside, el)).toBe(false)
    expect(canPull(null, el)).toBe(false)
  })
})
