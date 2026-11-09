import { describe, expect, it } from 'vitest'
import { classifySender } from './messages'

const ID = 'jpmimgldkledmklijfmfnbaaimmfjaaf'
const panel = { id: ID, url: `chrome-extension://${ID}/panel/index.html` } as chrome.runtime.MessageSender
const tab = (tabId: number) => ({ id: ID, url: 'https://news.example/a', tab: { id: tabId } as chrome.tabs.Tab }) as chrome.runtime.MessageSender

describe('classifySender', () => {
  it('accepts panel messages from our own pages only', () => {
    expect(classifySender({ type: 'panel.opened' }, panel, ID, [])).toBe('extension_page')
    expect(classifySender({ type: 'panel.opened' }, { ...panel, id: 'other' }, ID, [])).toBe('rejected')
    expect(classifySender({ type: 'panel.opened' }, { id: ID, url: 'https://evil.example/' }, ID, [])).toBe('rejected')
  })

  it('accepts in-page messages only from tabs we injected into, and only in-page types', () => {
    expect(classifySender({ type: 'inpage.ready', script: 'x' }, tab(7), ID, [7])).toBe('inpage')
    expect(classifySender({ type: 'inpage.ready', script: 'x' }, tab(8), ID, [7])).toBe('rejected')
    // A tab can't send what only the panel may send.
    expect(classifySender({ type: 'connection.changed' }, tab(7), ID, [7])).toBe('rejected')
  })

  it('rejects malformed messages', () => {
    expect(classifySender(null, panel, ID, [])).toBe('rejected')
    expect(classifySender({ type: 42 }, panel, ID, [])).toBe('rejected')
    expect(classifySender('panel.opened', panel, ID, [])).toBe('rejected')
  })
})
