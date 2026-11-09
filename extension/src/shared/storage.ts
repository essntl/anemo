/**
 * Typed access to chrome.storage.
 *
 * `local` holds what must survive a restart (server address, token, preferences): never
 * `sync`, so the token stays on this computer. `session` holds transient state (the open
 * chat's draft, what was injected where), cleared when the browser closes.
 */
import type { Connection } from './connection'
import type { Preferences } from './preferences'

/** A notification held back during focus (see background/notify.ts `Spec`). */
export interface HeldNotification {
  id: string
  type: import('./preferences').NotificationType
  title: string
  message: string
  target: { kind: 'chat'; conversationId: string } | { kind: 'anemo'; path: string } | { kind: 'none' }
  urgent: boolean
  at: number
}

export interface LocalData {
  connection: Connection | null
  preferences: Preferences
  /** Anemo's accent colour (Settings → Appearance), cached for the next panel start. */
  accent: string | null
  /** The chat open in the panel, and unsent drafts per chat ("new" for a new chat). */
  chat: { conversationId: string | null; drafts: Record<string, string> }
  /** Where the event stream got to: the last event id, and the time of the last event seen. */
  events: { lastId: string | null; lastSeenAt: number }
  /** Notifications held back during a focus session, shown as a summary when it ends. */
  heldNotifications: HeldNotification[]
  /** The project last chosen for a quick task. */
  lastProjectId: string | null
  /** The focus session as last known (feature 10 keeps it current). */
  focusState: { active: boolean; endsAt: number | null } | null
}

export interface SessionData {
  /** Tabs where an in-page script of ours runs (their messages are accepted). */
  injectedTabs: number[]
  /** The panel's open view and chat, so reopening the panel resumes. */
  panelState: { view: string; conversationId: string | null } | null
  /** The chat the panel shows right now, if it is open and visible. */
  panelFocus: { conversationId: string | null; visible: boolean; at: number } | null
  /** What a click on a notification opens, by notification id. */
  notificationTargets: Record<string, HeldNotification['target']>
  /** The event stream's state, for the settings view. */
  stream: { state: string; at: number; retryInMs?: number } | null
  /** The badge's inputs (focus minutes > research > pending approvals). */
  badge: { focusMinutes: number | null; research: boolean; approvals: number }
  /** Something for the panel to open a new chat with ("Discuss in chat"): a page and a draft. */
  pendingCompose: { page: import('./pageContext').PageContext | null; draft: string; at: number } | null
  /** A message for the panel after a context-menu action failed (e.g. the page can't be read). */
  panelNotice: { title: string; body: string; at: number } | null
  /** A capture started from the right-click menu or a shortcut, for the panel to finish. */
  pendingCapture: { kind: 'page' | 'selection' | 'task'; page: import('./pageContext').PageContext; at: number } | null
  /** Saves in progress or done, by id (from the event stream's capture events). */
  captures: Record<string, CaptureStatus>
}

export interface CaptureStatus {
  id: string
  status: 'queued' | 'formatting' | 'saving' | 'done' | 'failed'
  done: number
  total: number
  result: {
    document_id: string
    path: string
    title: string
    formatted: boolean
    undo: { kind: 'restore' | 'delete'; document_id: string; revision_id: string | null }
  } | null
  error: string | null
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
