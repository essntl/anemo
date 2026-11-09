import { describe, expect, it } from 'vitest'
import { originPattern, rememberedSites, siteName } from './sites'

describe('sites', () => {
  it('asks for one site: its scheme and host', () => {
    expect(originPattern('https://www.nature.com/articles/x?y=1')).toBe('https://www.nature.com/*')
    expect(originPattern('http://localhost:8080/a')).toBe('http://localhost/*')
    expect(originPattern('chrome://settings')).toBeNull()
    expect(originPattern('file:///tmp/a.pdf')).toBeNull()
    expect(originPattern(undefined)).toBeNull()
    expect(siteName('https://www.nature.com/*')).toBe('nature.com')
  })

  it('lists only the sites given with "Always allow"', () => {
    const all = ['https://anemo.example/*', 'https://www.youtube.com/*', '*://reddit.com/*', '*://*.reddit.com/*', 'https://www.nature.com/*', 'http://arxiv.org/*', 'https://*/*']
    expect(rememberedSites(all, 'https://anemo.example', true)).toEqual(['http://arxiv.org/*', 'https://www.nature.com/*'])
    expect(rememberedSites(all, 'https://anemo.example', false)).toContain('https://www.youtube.com/*')
  })
})
