import { describe, expect, it } from 'vitest'
import { blockedReason, DEFAULT_BLOCKLIST, elementLine, isFollowableLink, looksLikePersonCheck, normalizeEntry } from './browserControl'

const ANEMO = 'https://anemo.example.com'

describe('browser control', () => {
  it('never uses Anemo, Chrome’s pages, banks, government sites or the blocklist', () => {
    const block = (url: string) => blockedReason(url, DEFAULT_BLOCKLIST, ANEMO)
    expect(block('https://anemo.example.com/settings')).toContain('Anemo itself')
    expect(block('chrome://settings')).toContain('Only web pages')
    expect(block('chrome-extension://abc/page.html')).toContain('Only web pages')
    expect(block('file:///etc/passwd')).toContain('Only web pages')
    expect(block('https://www.paypal.com/checkout')).toContain('blocklist')
    expect(block('https://mail.google.com/mail/u/0')).toContain('blocklist')
    expect(block('https://netbank.example.no/')).toContain('looks like a bank')
    expect(block('https://www.irs.gov/')).toContain('government')
    expect(block('https://www.gov.uk/tax')).toContain('government')
    expect(block('https://accounts.google.com/signin')).toContain('blocklist')
    // proton.me/pass blocks that path only.
    expect(block('https://proton.me/pass/vault')).toContain('blocklist')
    expect(block('https://proton.me/mail')).toBeNull()
    expect(block('https://en.wikipedia.org/wiki/Photosynthesis')).toBeNull()
    expect(block('https://docs.google.com/document/d/1')).toBeNull()
  })

  it('turns what you type into a blocklist entry', () => {
    expect(normalizeEntry('https://www.Example.com/account/')).toBe('example.com/account')
    expect(normalizeEntry('reddit.com')).toBe('reddit.com')
    expect(normalizeEntry('intranet')).toBe('intranet')
    expect(normalizeEntry('not a site')).toBeNull()
  })

  it('a plain link to a page is only navigating; downloads and scripts are not', () => {
    expect(isFollowableLink('link', 'https://x.com/a', {})).toBe(true)
    expect(isFollowableLink('link', 'https://x.com/a.zip', {})).toBe(false)
    expect(isFollowableLink('link', 'https://x.com/a', { download: '' })).toBe(false)
    expect(isFollowableLink('link', 'javascript:void(0)', {})).toBe(false)
    expect(isFollowableLink('button', 'https://x.com/a', {})).toBe(false)
    expect(isFollowableLink('link', null, {})).toBe(false)
  })

  it('notices checks for people', () => {
    expect(looksLikePersonCheck('Verify you are human by completing the action below.', [])).toBe(true)
    expect(looksLikePersonCheck('Hello', ['https://www.google.com/recaptcha/api2/anchor?k=1'])).toBe(true)
    expect(looksLikePersonCheck('Hello', ['https://challenges.cloudflare.com/cdn-cgi/x'])).toBe(true)
    expect(looksLikePersonCheck('An article about robots and humans.', ['https://www.youtube.com/embed/x'])).toBe(false)
  })

  it('lists elements for the agent, never a password’s value', () => {
    expect(elementLine({ ref: 3, role: 'link', name: 'More  news', href: 'https://x.com/n', follow: true, password: false, value: null })).toBe('[3] link "More news" → https://x.com/n')
    expect(elementLine({ ref: 4, role: 'textbox', name: 'Password', href: null, follow: false, password: true, value: null })).toBe('[4] textbox "Password" (password: never typed into)')
    expect(elementLine({ ref: 5, role: 'textbox', name: 'Search', href: null, follow: false, password: false, value: 'shoes' })).toBe('[5] textbox "Search" (now: "shoes")')
  })
})
