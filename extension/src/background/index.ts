/**
 * The service worker. It is stateless: Chrome stops it when idle, so everything it needs
 * is read from chrome.storage when it wakes. Chat streaming runs in the side panel, not
 * here; the worker keeps the event stream (notifications, approvals, focus) and the badge.
 */
import { log } from '@/shared/env'
import { classifySender, type Message } from '@/shared/messages'
import { storage } from '@/shared/storage'
import { applyBadge } from './badge'
import { presenceChanged, releaseHeld, syncStream } from './events'
import { createMenus, listenForMenus } from './menus'
import { listenForClicks, trackWindows } from './notifier'

const HEARTBEAT = 'anemo-heartbeat'

async function setUp(): Promise<void> {
  // The toolbar icon opens the side panel.
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  // Wakes the worker every minute: reconnects the stream if the worker was stopped.
  await chrome.alarms.create(HEARTBEAT, { periodInMinutes: 1 })
  createMenus()
}

chrome.runtime.onInstalled.addListener(() => void setUp())
chrome.runtime.onStartup.addListener(() => void setUp())

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEARTBEAT) void syncStream()
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'connection' in changes) void syncStream()
  if (area === 'local' && 'preferences' in changes) presenceChanged()
  if (area === 'local' && 'focusState' in changes) {
    const before = changes.focusState.oldValue as { active?: boolean } | undefined
    const after = changes.focusState.newValue as { active?: boolean } | undefined
    if (before?.active && !after?.active) void releaseHeld()
  }
})

// Idle detection exists only once "Skip Discord while I'm here" was switched on.
function watchIdle(): void {
  if (chrome.idle && !chrome.idle.onStateChanged.hasListener(presenceChanged)) chrome.idle.onStateChanged.addListener(presenceChanged)
}
chrome.permissions.onAdded.addListener(() => watchIdle())
watchIdle()

chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
  void (async () => {
    const injected = (await storage.get('session', 'injectedTabs')) ?? []
    const from = classifySender(message, sender, chrome.runtime.id, injected)
    if (from === 'rejected') {
      log.debug('message ignored', { type: (message as { type?: string })?.type })
      sendResponse({ ok: false })
      return
    }
    if (message.type === 'connection.changed' || message.type === 'panel.opened') void syncStream()
    if (message.type === 'features.changed') presenceChanged()
    sendResponse({ ok: true })
  })()
  return true // answered asynchronously
})

listenForClicks()
listenForMenus()
trackWindows()
// Every time the worker starts (install, browser start, an alarm, a message).
void syncStream()
void storage.get('session', 'badge').then((b) => b && applyBadge(b))
