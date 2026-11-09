/**
 * Shows notifications and opens what they are about when clicked: a chat in the side
 * panel (an approval opens on its card), or the page in Anemo (a task, the calendar).
 */
import { storage } from '@/shared/storage'
import type { Spec, Target } from './notify'

const ICON = 'icons/icon-128.png'

export async function show(spec: Spec): Promise<void> {
  const targets = (await storage.get('session', 'notificationTargets')) ?? {}
  // Keep the map small: the newest 50 targets.
  const kept = Object.fromEntries([...Object.entries(targets).slice(-49), [spec.id, spec.target]])
  await storage.set('session', 'notificationTargets', kept)
  targetCache.set(spec.id, spec.target)
  await chrome.notifications.create(spec.id, {
    type: 'basic',
    iconUrl: ICON,
    title: spec.title,
    message: spec.message || ' ',
    priority: spec.urgent ? 2 : 0,
    // An approval stays until you look at it.
    requireInteraction: spec.type === 'approval',
    silent: false,
  })
}

/** Kept in memory too, so a click can open the panel before any await (Chrome only
 *  allows that during the click). Reloaded from storage when the worker restarts. */
const targetCache = new Map<string, Target>()
let lastWindowId: number | null = null

export function trackWindows(): void {
  chrome.windows.onFocusChanged.addListener((id) => {
    if (id !== chrome.windows.WINDOW_ID_NONE) lastWindowId = id
  })
  void chrome.windows.getLastFocused().then((w) => {
    if (w.id !== undefined && lastWindowId === null) lastWindowId = w.id
  }).catch(() => undefined)
  void storage.get('session', 'notificationTargets').then((t) => {
    for (const [id, target] of Object.entries(t ?? {})) if (!targetCache.has(id)) targetCache.set(id, target)
  })
}

async function showChat(conversationId: string): Promise<void> {
  const chat = await storage.get('local', 'chat')
  await storage.set('local', 'chat', { conversationId, drafts: chat?.drafts ?? {} })
  await storage.set('session', 'panelState', { view: 'chat', conversationId })
}

async function openInAnemo(path: string): Promise<void> {
  const connection = await storage.get('local', 'connection')
  if (!connection) return
  await chrome.tabs.create({ url: `${connection.serverUrl}${path}` })
}

/** Opens what a notification is about. Call it straight from the click handler. */
export function open(target: Target): void {
  if (target.kind === 'chat') {
    // First, while the click still counts as a user action; the panel then follows the
    // chat change in storage. If Chrome refuses, the chat opens in Anemo instead.
    const opening = lastWindowId !== null ? chrome.sidePanel.open({ windowId: lastWindowId }) : Promise.reject(new Error('no window'))
    void opening.then(
      () => showChat(target.conversationId),
      () => showChat(target.conversationId).then(() => openInAnemo(`/c/${target.conversationId}`)),
    )
  } else if (target.kind === 'anemo') {
    void openInAnemo(target.path)
  }
}

export function listenForClicks(): void {
  chrome.notifications.onClicked.addListener((id) => {
    const target = targetCache.get(id)
    if (target) open(target)
    void chrome.notifications.clear(id)
    if (!target) {
      // The worker restarted since: the panel can't be opened now, Anemo can.
      void storage.get('session', 'notificationTargets').then((t) => {
        const stored = t?.[id]
        if (stored?.kind === 'chat') void openInAnemo(`/c/${stored.conversationId}`)
        else if (stored?.kind === 'anemo') void openInAnemo(stored.path)
      })
    }
  })
}
