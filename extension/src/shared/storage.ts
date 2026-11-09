/**
 * Typed access to chrome.storage.
 *
 * `local` holds what must survive a restart (server address, token, preferences): never
 * `sync`, so the token stays on this computer. `session` holds transient state (the open
 * chat's draft, what was injected where), cleared when the browser closes.
 */
import type { Connection } from './connection'
import type { Preferences } from './preferences'

export interface LocalData {
  connection: Connection | null
  preferences: Preferences
  /** Anemo's accent colour (Settings → Appearance), cached for the next panel start. */
  accent: string | null
  /** The chat open in the panel, and unsent drafts per chat ("new" for a new chat). */
  chat: { conversationId: string | null; drafts: Record<string, string> }
}

export interface SessionData {
  /** Tabs where an in-page script of ours runs (their messages are accepted). */
  injectedTabs: number[]
  /** The panel's open view and chat, so reopening the panel resumes. */
  panelState: { view: string; conversationId: string | null } | null
}

type Area = 'local' | 'session'
type DataOf<A extends Area> = A extends 'local' ? LocalData : SessionData

async function get<A extends Area, K extends keyof DataOf<A>>(
  area: A,
  key: K,
): Promise<DataOf<A>[K] | undefined> {
  const out = await chrome.storage[area].get(key as string)
  return out[key as string] as DataOf<A>[K] | undefined
}

async function set<A extends Area, K extends keyof DataOf<A>>(area: A, key: K, value: DataOf<A>[K]): Promise<void> {
  await chrome.storage[area].set({ [key as string]: value })
}

async function remove<A extends Area>(area: A, key: keyof DataOf<A>): Promise<void> {
  await chrome.storage[area].remove(key as string)
}

/** Calls `fn` with the new value whenever `key` changes in `area`; returns an unsubscribe. */
function watch<A extends Area, K extends keyof DataOf<A>>(
  area: A,
  key: K,
  fn: (value: DataOf<A>[K] | undefined) => void,
): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, changedArea: string) => {
    if (changedArea === area && key in changes) fn(changes[key as string].newValue as DataOf<A>[K] | undefined)
  }
  chrome.storage.onChanged.addListener(listener)
  return () => chrome.storage.onChanged.removeListener(listener)
}

export const storage = { get, set, remove, watch }
