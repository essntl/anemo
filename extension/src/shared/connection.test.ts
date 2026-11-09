import { describe, expect, it } from 'vitest'
import { originPattern, parseServerUrl } from './connection'

describe('parseServerUrl', () => {
  it('adds https:// and drops a trailing slash', () => {
    expect(parseServerUrl('ai.example.com')).toEqual({ ok: true, url: 'https://ai.example.com', insecure: false })
    expect(parseServerUrl('  https://ai.example.com/  ')).toEqual({ ok: true, url: 'https://ai.example.com', insecure: false })
    expect(parseServerUrl('https://ai.example.com:8443')).toMatchObject({ ok: true, url: 'https://ai.example.com:8443' })
  })

  it('allows plain http only on a local network', () => {
    expect(parseServerUrl('http://192.168.1.20:8080')).toEqual({ ok: true, url: 'http://192.168.1.20:8080', insecure: true })
    expect(parseServerUrl('http://localhost:8080')).toMatchObject({ ok: true, insecure: true })
    expect(parseServerUrl('http://nas.local')).toMatchObject({ ok: true })
    expect(parseServerUrl('http://ai.example.com')).toMatchObject({ ok: false })
  })

  it('refuses paths, credentials, other schemes and empty input', () => {
    expect(parseServerUrl('https://ai.example.com/anemo')).toMatchObject({ ok: false })
    expect(parseServerUrl('https://me:pw@ai.example.com')).toMatchObject({ ok: false })
    expect(parseServerUrl('ftp://ai.example.com')).toMatchObject({ ok: false })
    expect(parseServerUrl('   ')).toMatchObject({ ok: false })
    expect(parseServerUrl('https://exa mple')).toMatchObject({ ok: false })
  })

  it('builds the host permission pattern', () => {
    expect(originPattern('https://ai.example.com')).toBe('https://ai.example.com/*')
  })
})
