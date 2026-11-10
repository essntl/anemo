import { describe, expect, it } from 'vitest'
import { trackGradient, waveform } from './look'

describe('the look of a track', () => {
  it('is the same for a track every time, and differs between tracks', () => {
    expect(trackGradient('yt:abc')).toBe(trackGradient('yt:abc'))
    expect(trackGradient('yt:abc')).not.toBe(trackGradient('yt:xyz'))
    expect(waveform('yt:abc', 48)).toEqual(waveform('yt:abc', 48))
    expect(waveform('yt:abc', 48)).not.toEqual(waveform('yt:xyz', 48))
  })

  it('keeps the gradient dark enough for white text', () => {
    const lightness = [...trackGradient('some track').matchAll(/hsl\(\d+ \d+% (\d+)%\)/g)].map((m) => Number(m[1]))
    expect(lightness).toHaveLength(3)
    expect(Math.max(...lightness)).toBeLessThanOrEqual(36)
  })

  it('falls back to the accent without a track', () => {
    expect(trackGradient(null)).toContain('var(--accent)')
  })

  it('gives as many bars as asked for, each between 0.2 and 1', () => {
    const bars = waveform('yt:abc', 60)
    expect(bars).toHaveLength(60)
    expect(Math.min(...bars)).toBeGreaterThanOrEqual(0.2)
    expect(Math.max(...bars)).toBeLessThanOrEqual(1)
    expect(waveform(null, 4)).toHaveLength(4)
  })
})
