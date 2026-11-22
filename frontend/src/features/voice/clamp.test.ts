import { describe, expect, it } from 'vitest'
import { clampInt } from './clamp'

describe('clampInt', () => {
  it('keeps a number within its limits', () => {
    expect(clampInt('5', 0, 60)).toBe(5)
    expect(clampInt('61', 0, 60)).toBe(60)
    expect(clampInt('-3', 0, 60)).toBe(0)
    expect(clampInt('7.6', 0, 60)).toBe(8)
    expect(clampInt('', 100, 2000)).toBe(100)
    expect(clampInt('abc', 100, 2000)).toBe(100)
  })
})
