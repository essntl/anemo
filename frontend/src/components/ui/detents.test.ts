import { describe, expect, it } from 'vitest'
import { restingPlace } from './detents'

const HALF = 400
const FULL = 700
const rest = (height: number, velocity: number, from: 'half' | 'full', full = FULL) => restingPlace({ height, velocity, from }, HALF, full)

describe('where a two-height sheet comes to rest', () => {
  it('goes to the nearer height when let go slowly', () => {
    expect(rest(480, 0, 'half')).toBe('half')
    expect(rest(600, 0, 'half')).toBe('full')
    expect(rest(520, 0.1, 'full')).toBe('half')
  })

  it('goes away when pulled well below the first height', () => {
    expect(rest(200, 0, 'half')).toBe('closed')
    expect(rest(300, 0, 'half')).toBe('half')
  })

  it('follows a flick: up to the top, down one step at a time', () => {
    expect(rest(430, -1, 'half')).toBe('full')
    expect(rest(650, 1, 'full')).toBe('half')
    expect(rest(380, 1, 'half')).toBe('closed')
  })

  it('has one height when everything fits at the first', () => {
    expect(rest(430, -1, 'half', HALF + 10)).toBe('half')
    expect(rest(380, 1, 'full', HALF + 10)).toBe('closed')
    expect(rest(405, 0, 'half', HALF + 10)).toBe('half')
  })
})
