import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { topBarEnd } from '@/components/ui/topBarSlots'

let phone = true
vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: () => phone }))

const { useIslandSide } = await import('./useIslandSide')

function Side() {
  return <output>{useIslandSide()}</output>
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

  it('is the middle when the page has a button there', () => {
    bar([0, 40])
    render(<Side />)
    expect(screen.getByRole('status')).toHaveTextContent('center')
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
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('center'))
  })
})
