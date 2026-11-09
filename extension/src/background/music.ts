/**
 * Music in the worker: our script runs in Anemo's tabs (registered for the Anemo address
 * only, and put into Anemo tabs already open), and what each tab's player reports is kept
 * for the panel. Commands go from the panel to the tab directly.
 */
import { log } from '@/shared/env'
import { BRIDGE_ID, BRIDGE_SCRIPT, cleanState, type MusicTab } from '@/shared/music'
import { storage } from '@/shared/storage'

let registeredFor: string | null | undefined

/** Our script in the tabs of this Anemo address (none when signed out). Safe to call often. */
export async function registerBridge(serverUrl: string | null): Promise<void> {
  const origin = serverUrl ? new URL(serverUrl).origin : null
  if (origin === registeredFor) return
  registeredFor = origin
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [BRIDGE_ID] })
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [BRIDGE_ID] })
    await storage.set('session', 'musicTabs', {})
    if (!origin) return
    await chrome.scripting.registerContentScripts([{ id: BRIDGE_ID, matches: [`${origin}/*`], js: [BRIDGE_SCRIPT], runAt: 'document_idle', persistAcrossSessions: true }])
    await injectIntoOpenTabs(origin)
  } catch (err) {
    registeredFor = undefined // try again next time
    log.debug('music bridge not registered', { error: String(err) })
  }
}

/** Anemo tabs opened before the script was registered get it now (it runs once per page). */
export async function injectIntoOpenTabs(origin: string): Promise<void> {
  const tabs = await chrome.tabs.query({ url: `${origin}/*` })
  for (const tab of tabs) {
    if (tab.id === undefined) continue
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [BRIDGE_SCRIPT] }).catch(() => undefined)
  }
}

/** A report from an Anemo tab (already checked to come from the Anemo address). */
export async function onMusicMessage(message: { type: string; [k: string]: unknown }, tabId: number): Promise<void> {
  if (message.type === 'music.state') {
    const state = cleanState(message.state)
    if (!state) return
    const tabs = (await storage.get('session', 'musicTabs')) ?? {}
    const entry: MusicTab = { tabId, state, at: Date.now() }
    await storage.set('session', 'musicTabs', { ...tabs, [String(tabId)]: entry })
  } else if (message.type === 'music.added') {
    const { id, ok, error, count } = message as unknown as { id: string; ok: boolean; error: string | null; count: number }
    await storage.set('session', 'musicAdded', { id, ok, error, count, at: Date.now() })
  }
}

export async function forgetTab(tabId: number): Promise<void> {
  const tabs = (await storage.get('session', 'musicTabs')) ?? {}
  if (!(String(tabId) in tabs)) return
  const { [String(tabId)]: _gone, ...rest } = tabs
  await storage.set('session', 'musicTabs', rest)
}
