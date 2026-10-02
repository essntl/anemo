import { describe, expect, it } from 'vitest'
import { expiryLabel, shareUrl } from './links'

describe('share links', () => {
  it('builds the address from the site and the token', () => {
    expect(shareUrl('abc_123', 'https://anemo.example')).toBe('https://anemo.example/s/abc_123')
  })

  it('says when a link stops working', () => {
    const now = new Date(2026, 9, 2, 12, 0)
    expect(expiryLabel({ expires_at: null, expired: false }, now)).toBe('No expiry')
    expect(expiryLabel({ expires_at: new Date(2026, 9, 1, 12, 0).toISOString(), expired: true }, now)).toBe('Expired')
    // Loaded a while ago and run out since: also expired.
    expect(expiryLabel({ expires_at: new Date(2026, 9, 2, 11, 59).toISOString(), expired: false }, now)).toBe('Expired')
    expect(expiryLabel({ expires_at: new Date(2026, 9, 3, 8, 0).toISOString(), expired: false }, now)).toMatch(/^Expires Tomorrow /)
  })
})
