import { beforeEach, describe, expect, it } from 'vitest'
import { focusQueue, useFocusQueue } from './queueStore'

beforeEach(() => useFocusQueue.setState({ ids: [] }))

describe('the focus queue', () => {
  it('keeps tasks in the order they were added, each once', () => {
    focusQueue.add('a')
    focusQueue.add('b')
    focusQueue.add('a')
    expect(useFocusQueue.getState().ids).toEqual(['a', 'b'])
    focusQueue.remove('a')
    expect(useFocusQueue.getState().ids).toEqual(['b'])
  })

  it('hands out the first task that is still open, and forgets the ones that are not', () => {
    useFocusQueue.setState({ ids: ['done-elsewhere', 'b', 'c'] })
    expect(focusQueue.next(new Set(['b', 'c']))).toBe('b')
    expect(useFocusQueue.getState().ids).toEqual(['c'])
  })

  it('has nothing to hand out when it is empty', () => {
    expect(focusQueue.next(new Set(['a']))).toBeNull()
    expect(useFocusQueue.getState().ids).toEqual([])
  })
})
