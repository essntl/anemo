/**
 * The service worker. It is stateless: Chrome stops it when idle, so everything it needs
 * is read from chrome.storage when it wakes. Chat streaming runs in the side panel, not here.
 */
import { log } from '@/shared/env'
import { classifySender, type Message } from '@/shared/messages'
import { storage } from '@/shared/storage'

async function setUp(): Promise<void> {
  // The toolbar icon opens the side panel.
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
}

chrome.runtime.onInstalled.addListener(() => void setUp())
chrome.runtime.onStartup.addListener(() => void setUp())

chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
  void (async () => {
    const injected = (await storage.get('session', 'injectedTabs')) ?? []
    const from = classifySender(message, sender, chrome.runtime.id, injected)
    if (from === 'rejected') {
      log.debug('message ignored', { type: (message as { type?: string })?.type })
      sendResponse({ ok: false })
      return
    }
    log.debug('message', { type: message.type, from })
    sendResponse({ ok: true })
  })()
  return true // answered asynchronously
})
