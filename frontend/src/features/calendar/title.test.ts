import { shortTitle } from './title'

describe('shortTitle', () => {
  it('names a month by its short name and year', () => {
    expect(shortTitle({ start: '2026-11-01', end: '2026-12-01' }, true, 'en-US')).toBe('Nov 2026')
  })

  it('names one day', () => {
    expect(shortTitle({ start: '2026-11-11', end: '2026-11-12' }, false, 'en-US')).toBe('Nov 11')
  })

  it('names a few days as a range, the last day included', () => {
    expect(shortTitle({ start: '2026-11-10', end: '2026-11-13' }, false, 'en-US')).toMatch(/^Nov 10\s–\s12$/)
  })

  it('names a range across two months', () => {
    expect(shortTitle({ start: '2026-11-29', end: '2026-12-02' }, false, 'en-US')).toMatch(/^Nov 29\s–\sDec 1$/)
  })
})
