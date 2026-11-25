import { describe, expect, it } from 'vitest'
import { mergeIntoFull, orderAfterMove, stepSlot } from './placement'

describe('a card put in a column', () => {
  it('goes in front of the card it was dropped on, or at the end', () => {
    expect(orderAfterMove(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b'])
    expect(orderAfterMove(['a', 'b', 'c'], 'a', null)).toEqual(['b', 'c', 'a'])
    expect(orderAfterMove(['a', 'b'], 'x', 'b')).toEqual(['a', 'x', 'b'])
  })
})

describe('the whole column, when a filter hides some of its cards', () => {
  // The column is a h1 b h2 c; the board shows a b c (h1, h2 hidden).
  const full = ['a', 'h1', 'b', 'h2', 'c']

  it('keeps the hidden cards where they were', () => {
    // c dragged in front of b.
    expect(mergeIntoFull(full, ['a', 'c', 'b'], 'c')).toEqual(['a', 'h1', 'c', 'b', 'h2'])
    // a dragged to the end: right after c, the last card shown.
    expect(mergeIntoFull(full, ['b', 'c', 'a'], 'a')).toEqual(['h1', 'b', 'h2', 'c', 'a'])
  })

  it('puts a card from another column after the one it follows, or at the end of an empty-looking column', () => {
    expect(mergeIntoFull(full, ['a', 'b', 'c', 'x'], 'x')).toEqual(['a', 'h1', 'b', 'h2', 'c', 'x'])
    expect(mergeIntoFull(['h1', 'h2'], ['x'], 'x')).toEqual(['h1', 'h2', 'x'])
  })
})

describe('moving a picked-up card with the arrow keys', () => {
  const sizes = [2, 0, 3]
  const ordered = [true, true, false]

  it('goes up and down in its column, within its ends', () => {
    expect(stepSlot({ column: 0, index: 1 }, 'ArrowUp', sizes, ordered)).toEqual({ column: 0, index: 0 })
    expect(stepSlot({ column: 0, index: 0 }, 'ArrowUp', sizes, ordered)).toEqual({ column: 0, index: 0 })
    expect(stepSlot({ column: 0, index: 2 }, 'ArrowDown', sizes, ordered)).toEqual({ column: 0, index: 2 })
  })

  it('goes sideways to the same height, or the end of a column that sorts itself', () => {
    expect(stepSlot({ column: 0, index: 1 }, 'ArrowRight', sizes, ordered)).toEqual({ column: 1, index: 0 })
    expect(stepSlot({ column: 1, index: 0 }, 'ArrowRight', sizes, ordered)).toEqual({ column: 2, index: 3 })
    expect(stepSlot({ column: 2, index: 3 }, 'ArrowRight', sizes, ordered)).toEqual({ column: 2, index: 3 })
    expect(stepSlot({ column: 2, index: 3 }, 'ArrowDown', sizes, ordered)).toEqual({ column: 2, index: 3 })
    expect(stepSlot({ column: 0, index: 1 }, 'ArrowLeft', sizes, ordered)).toEqual({ column: 0, index: 1 })
  })
})
