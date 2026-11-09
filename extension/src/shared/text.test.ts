import { describe, expect, it } from 'vitest'
import { stripCitationMarkup } from './text'

describe('stripCitationMarkup', () => {
  it('hides citation markup, also a dangling one while streaming', () => {
    expect(stripCitationMarkup('Aciteturn0 B')).toBe('A B')
    expect(stripCitationMarkup('A citetu')).toBe('A ')
    expect(stripCitationMarkup('plain')).toBe('plain')
  })
})
