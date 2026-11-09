import { describe, expect, it } from 'vitest'
import { resolveHref } from './links'

describe('resolveHref', () => {
  it('opens Anemo paths in Anemo and keeps web links', () => {
    expect(resolveHref('/documents/abc', 'https://ai.example.com')).toBe('https://ai.example.com/documents/abc')
    expect(resolveHref('https://en.wikipedia.org/wiki/X', 'https://a')).toBe('https://en.wikipedia.org/wiki/X')
  })

  it('drops script and other schemes, and protocol-relative links', () => {
    expect(resolveHref('javascript:alert(1)', 'https://a')).toBeUndefined()
    expect(resolveHref('data:text/html,x', 'https://a')).toBeUndefined()
    expect(resolveHref('//evil.example/x', 'https://a')).toBeUndefined()
  })
})
