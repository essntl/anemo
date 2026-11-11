import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { topBarEnd } from '@/components/ui/topBarSlots'

let phone = true
vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: () => phone }))

const { roomBetween, useIslandPlace } = await import('./useIslandSide')

function Side() {
  return <output>{useIslandPlace().place}</output>
}

/** jsdom lays nothing out: say what would be on screen. */
function shown(el: HTMLElement, width: number) {
  Object.defineProperty(el, 'offsetParent', { configurable: true, get: () => (width >= 0 ? document.body : null) })
  Object.defineProperty(el, 'offsetWidth', { configurable: true, get: () => Math.max(width, 0) })
}

/** The right part of the top bar, with these buttons in it (their widths; 0 is one hidden on a phone). */
function bar(buttons: number[], visible = true): HTMLElement {
  const end = document.createElement('div')
  shown(end, visible ? 4 : -1)
  for (const width of buttons) {
    const button = document.createElement('button')
    shown(button, width)
    end.append(button)
  }
  document.body.append(end)
  act(() => topBarEnd(end))
  return end
}

afterEach(() => {
  act(() => topBarEnd(null))
  document.body.replaceChildren()
  phone = true
})

describe('where the Island sits', () => {
  it('is the middle while there is no top bar (a conversation)', () => {
    render(<Side />)
    expect(screen.getByRole('status')).toHaveTextContent('center')
  })

  it('is the right end on a phone when the page has no buttons there', () => {
    bar([])
    render(<Side />)
    expect(screen.getByRole('status')).toHaveTextContent('end')
  })

  it('counts buttons that are hidden on a phone as not there', () => {
    bar([0, 0])
    render(<Side />)
    expect(screen.getByRole('status')).toHaveTextContent('end')
  })

  it('is between the two sides, at its smallest, when the page has a button there', () => {
    bar([0, 40])
    render(<Side />)
    expect(screen.getByRole('status')).toHaveTextContent('between')
  })

  it('is the middle on a wider screen, whatever the bar holds', () => {
    phone = false
    bar([])
    render(<Side />)
    expect(screen.getByRole('status')).toHaveTextContent('center')
  })

  it('is the middle while the bar itself is hidden (a page with its own phone header)', () => {
    bar([], false)
    render(<Side />)
    expect(screen.getByRole('status')).toHaveTextContent('center')
  })

  it('follows the page: a button that arrives moves it back to the middle', async () => {
    const end = bar([])
    render(<Side />)
    expect(screen.getByRole('status')).toHaveTextContent('end')
    const button = document.createElement('button')
    shown(button, 40)
    act(() => { end.append(button) })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('between'))
  })
})

describe('the room between the title and the buttons', () => {
  /** An element that is drawn from `left` to `right`, whose content would need `natural` pixels. */
  function box(tag: string, left: number, right: number, natural = right - left, clips = natural !== right - left): HTMLElement {
    const el = document.createElement(tag)
    // Text that is cut off sits in an element that clips it.
    if (clips) el.style.overflowX = 'hidden'
    el.getBoundingClientRect = () => ({ left, right, width: right - left, top: 0, bottom: 0, height: 0, x: left, y: 0, toJSON: () => ({}) })
    Object.defineProperty(el, 'clientWidth', { configurable: true, get: () => right - left })
    Object.defineProperty(el, 'scrollWidth', { configurable: true, get: () => natural })
    Object.defineProperty(el, 'offsetWidth', { configurable: true, get: () => right - left })
    return el
  }

  /** A 375px bar: a title and a line under it at the left, buttons at the right. */
  function topBar(title: HTMLElement, under: HTMLElement | null, buttons: HTMLElement[]) {
    const bar = box('header', 0, 375)
    const lines = box('div', 6, 180)
    const start = box('div', 16, 180)
    start.append(title)
    lines.append(start)
    if (under) {
      const line = box('div', 16, 180)
      line.append(under)
      lines.append(line)
    }
    const end = box('div', 200, 369)
    end.style.paddingRight = '4px'
    end.style.columnGap = '6px'
    end.append(...buttons)
    bar.append(lines, end)
    document.body.append(bar)
    return { start, end }
  }

  it('is twice the smaller distance from the middle, less a gap on each side', () => {
    // Title to 60, the line under it to 127; one button, 100 wide, ending at 365.
    const { start, end } = topBar(box('h1', 16, 60), box('button', 16, 127), [box('button', 265, 365)])
    // Middle 187.5: 60.5 to the left, 77.5 to the right.
    expect(roomBetween(start, end)).toBe(2 * 60.5 - 16)
  })

  it('counts a cut-off title and a squeezed button at their full widths', () => {
    // The title is drawn to 100 but would need 30 more; the button is drawn 80 wide but would need 100.
    const { start, end } = topBar(box('h1', 16, 100, 114), null, [box('button', 285, 365, 100)])
    // Title would end at 130; the button would start at 265: 57.5 and 77.5 from the middle.
    expect(roomBetween(start, end)).toBe(2 * 57.5 - 16)
  })

  it('does not take what merely reaches past its box (a larger tap area) for cut-off text', () => {
    // The line under the title is drawn to 127 and reports 8px more, without clipping anything.
    const { start, end } = topBar(box('h1', 16, 60), box('button', 16, 127, 119, false), [box('button', 265, 365)])
    expect(roomBetween(start, end)).toBe(2 * 60.5 - 16)
  })

  it('does not count a label that is there for screen readers only', () => {
    // An icon button, 40 wide, with its name in a clipped 1px box inside.
    const button = box('button', 325, 365)
    button.append(box('span', 344, 345, 77))
    const { start, end } = topBar(box('h1', 16, 60), null, [button])
    // Title to 60, the button from 325: 127.5 and 137.5 from the middle.
    expect(roomBetween(start, end)).toBe(2 * 127.5 - 16)
  })

  it('adds up several buttons with the gaps between them', () => {
    const { start, end } = topBar(box('h1', 16, 60), null, [box('button', 240, 272), box('button', 272, 304), box('button', 306, 365)])
    // 32 + 32 + 59 wide with two gaps of 6, back from 365: they start at 230.
    expect(roomBetween(start, end)).toBe(2 * 42.5 - 16)
  })

  it('is never less than nothing', () => {
    const { start, end } = topBar(box('h1', 16, 220), null, [box('button', 150, 365)])
    expect(roomBetween(start, end)).toBe(0)
  })
})
