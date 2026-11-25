import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Board, type BoardColumn, type BoardMove } from './Board'
import { LONG_PRESS_MS } from './usePointerDrag'

type Card = { id: string; title: string }
const card = (id: string): Card => ({ id, title: `Card ${id}` })

function setup(columns: BoardColumn<Card>[], onOpen = vi.fn()) {
  const moves: BoardMove[] = []
  render(
    <Board label="Test board" columns={columns} itemId={(c) => c.id} itemLabel={(c) => c.title}
      onOpen={onOpen} onMove={(m) => moves.push(m)} renderCard={(c) => <span>{c.title}</span>} />,
  )
  return { moves, onOpen }
}

const twoColumns = (): BoardColumn<Card>[] => [
  { id: 'todo', label: 'To do', items: [card('a'), card('b')] },
  { id: 'doing', label: 'Doing', items: [card('c')] },
  { id: 'done', label: 'Done', items: [card('d')], ordered: false },
]
const cardEl = (title: string) => screen.getByText(title).closest<HTMLElement>('[data-board-card]')!
const live = () => document.querySelector('[aria-live]')!.textContent

// jsdom has no layout, so no scrolling either.
beforeAll(() => {
  Element.prototype.scrollBy = () => {}
  Element.prototype.scrollIntoView = () => {}
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the board', () => {
  it('shows each column with its cards and their number', () => {
    setup(twoColumns())
    const todo = screen.getByRole('region', { name: 'To do' })
    expect(within(todo).getAllByRole('button').map((b) => b.textContent)).toEqual(['Card a', 'Card b'])
    expect(todo.querySelector('header')!.textContent).toBe('To do 2')
  })

  it('opens a card with a click or Enter', () => {
    const { onOpen } = setup(twoColumns())
    fireEvent.click(cardEl('Card c'))
    fireEvent.keyDown(cardEl('Card a'), { key: 'Enter' })
    expect(onOpen.mock.calls.map(([c]) => c.id)).toEqual(['c', 'a'])
  })
})

describe('moving a card with the keyboard', () => {
  it('picks it up with Space, moves it with the arrows and puts it down with Space, telling screen readers', () => {
    const { moves } = setup(twoColumns())
    const a = cardEl('Card a')
    fireEvent.keyDown(a, { key: ' ' })
    expect(live()).toMatch(/^Picked up Card a\./)
    fireEvent.keyDown(a, { key: 'ArrowRight' })
    expect(live()).toBe('Doing, position 1 of 2')
    fireEvent.keyDown(a, { key: 'ArrowDown' })
    expect(live()).toBe('Doing, position 2 of 2')
    fireEvent.keyDown(a, { key: ' ' })
    expect(moves).toEqual([{ id: 'a', from: 'todo', to: 'doing', before: null, order: ['c', 'a'] }])
    expect(live()).toBe('Card a moved to Doing, position 2 of 2.')
  })

  it('reorders within the column', () => {
    const { moves } = setup(twoColumns())
    const b = cardEl('Card b')
    fireEvent.keyDown(b, { key: ' ' })
    fireEvent.keyDown(b, { key: 'ArrowUp' })
    fireEvent.keyDown(b, { key: 'Enter' })
    expect(moves).toEqual([{ id: 'b', from: 'todo', to: 'todo', before: 'a', order: ['b', 'a'] }])
  })

  it('puts a card at the end of a column that sorts itself', () => {
    const { moves } = setup(twoColumns())
    const c = cardEl('Card c')
    fireEvent.keyDown(c, { key: ' ' })
    fireEvent.keyDown(c, { key: 'ArrowRight' })
    expect(live()).toBe('Done')
    fireEvent.keyDown(c, { key: ' ' })
    expect(moves).toEqual([{ id: 'c', from: 'doing', to: 'done', before: null, order: ['d', 'c'] }])
  })

  it('puts it back with Escape, and does nothing when put down where it was', () => {
    const { moves } = setup(twoColumns())
    const a = cardEl('Card a')
    fireEvent.keyDown(a, { key: ' ' })
    fireEvent.keyDown(a, { key: 'ArrowRight' })
    fireEvent.keyDown(a, { key: 'Escape' })
    expect(live()).toBe('Card a put back.')
    fireEvent.keyDown(a, { key: ' ' })
    fireEvent.keyDown(a, { key: ' ' })
    expect(live()).toBe('Card a put down where it was.')
    expect(moves).toEqual([])
  })
})

describe('dragging a card with a pointer', () => {
  /** The pointer is over column `id` (jsdom has no layout: every card's box is at 0). */
  const pointAt = (id: string) => {
    const column = document.querySelector(`[data-board-column="${id}"]`)!
    document.elementFromPoint = () => column
  }

  it('drags with the mouse once it has moved a little', () => {
    vi.useFakeTimers()
    const { moves, onOpen } = setup(twoColumns())
    fireEvent.pointerDown(cardEl('Card a'), { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 10, clientY: 10 })
    pointAt('doing')
    act(() => { window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 40, clientY: 40 })) })
    act(() => { window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 300, clientY: 40 })) })
    act(() => { window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 300, clientY: 40 })) })
    expect(moves).toEqual([{ id: 'a', from: 'todo', to: 'doing', before: null, order: ['c', 'a'] }])
    // The click the drop ends with doesn't open the card.
    fireEvent.click(cardEl('Card a'))
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('needs a long press with a finger; a swipe scrolls instead', () => {
    vi.useFakeTimers()
    const { moves } = setup(twoColumns())
    // A swipe: moves before the long press is over.
    fireEvent.pointerDown(cardEl('Card a'), { pointerId: 2, pointerType: 'touch', clientX: 10, clientY: 10 })
    act(() => { window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 2, clientX: 60, clientY: 10 })) })
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 50) })
    act(() => { window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2 })) })
    expect(moves).toEqual([])
    // A long press, then a drag.
    fireEvent.pointerDown(cardEl('Card b'), { pointerId: 3, pointerType: 'touch', clientX: 10, clientY: 10 })
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 50) })
    pointAt('done')
    act(() => { window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 3, clientX: 500, clientY: 10 })) })
    act(() => { window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 3 })) })
    expect(moves).toEqual([{ id: 'b', from: 'todo', to: 'done', before: null, order: ['d', 'b'] }])
  })
})
