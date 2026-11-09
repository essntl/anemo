/**
 * The service worker. It is stateless: Chrome stops it when idle, so everything it needs
 * is read from chrome.storage when it wakes. Chat streaming runs in the side panel, not
 * here; the worker keeps the event stream (notifications, approvals, focus) and the badge.
 */
import { E2E, log } from '@/shared/env'
import { classifySender, type Message } from '@/shared/messages'
import { storage } from '@/shared/storage'
import { applyBadge } from './badge'
import { presenceChanged, releaseHeld, syncStream } from './events'
import { applyFocus, FOCUS_END, FOCUS_TICK, refreshFocus, tick } from './focus'
import { listenForInline } from './inline'
import { onInlineClick } from './inlineMenu'
import { createMenus, handle, listenForMenus } from './menus'
import { listenForClicks, trackWindows } from './notifier'
import { forgetTab, onMusicMessage, registerBridge } from './music'

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
  if (alarm.name === FOCUS_TICK || alarm.name === FOCUS_END) void tick()
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'connection' in changes) void syncStream()
  if (area === 'local' && 'preferences' in changes) {
    presenceChanged()
    const before = (changes.preferences.oldValue as { targetLanguage?: string } | undefined)?.targetLanguage
    const after = (changes.preferences.newValue as { targetLanguage?: string } | undefined)?.targetLanguage
    if (before !== after) createMenus() // the default language comes first in Translate
  }
  // The timer or the distraction list changed: the badge and the blocking rules follow.
  if (area === 'local' && ('focusTimer' in changes || 'preferences' in changes)) void applyFocus()
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
chrome.permissions.onAdded.addListener(() => {
  watchIdle()
  void applyFocus() // a site on the distraction list was granted
})
chrome.permissions.onRemoved.addListener(() => void applyFocus())
watchIdle()

chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
  void (async () => {
    const injected = (await storage.get('session', 'injectedTabs')) ?? []
    const connection = await storage.get('local', 'connection')
    const anemoOrigin = connection?.token ? new URL(connection.serverUrl).origin : null
    const from = classifySender(message, sender, chrome.runtime.id, injected, anemoOrigin)
    if (from === 'rejected') {
      log.debug('message ignored', { type: (message as { type?: string })?.type })
      sendResponse({ ok: false })
      return
    }
    if (message.type === 'connection.changed' || message.type === 'panel.opened') void syncStream()
    if (message.type === 'panel.opened') void refreshFocus() // the panel shows the timer: be current
    if (message.type === 'features.changed') presenceChanged()
    if (from === 'anemo_tab' && sender.tab?.id !== undefined) await onMusicMessage(message, sender.tab.id)
    sendResponse({ ok: true })
  })()
  return true // answered asynchronously
})

chrome.tabs.onRemoved.addListener((tabId) => void forgetTab(tabId))

/** Our music script follows the Anemo address (none when signed out). */
async function syncBridge(): Promise<void> {
  const connection = await storage.get('local', 'connection')
  await registerBridge(connection?.token ? connection.serverUrl : null)
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'connection' in changes) void syncBridge()
})
void syncBridge()

listenForClicks()
listenForMenus()
listenForInline()
trackWindows()
// Every time the worker starts (install, browser start, an alarm, a message).
void syncStream()
void storage.get('session', 'badge').then((b) => b && applyBadge(b))
// Rules and badge as the stored timer says now (a phase may have ended while the browser slept).
void tick()

// The Playwright build only: tests can't click Chrome's context menu, so they call its handler.
if (E2E) (globalThis as unknown as { __anemoTest: unknown }).__anemoTest = { onInlineClick, handle }
