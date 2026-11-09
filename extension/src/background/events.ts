/**
 * The worker's side of the event stream: keeps it connected while a token is saved,
 * turns Anemo's events into notifications and the badge, catches up after the browser was
 * closed, and holds non-urgent notifications during a focus session.
 *
 * Catching up: after a reconnect the server replays what happened since the last event
 * seen. When that is no longer in the stream (or the stream was never read), the
 * notification list and pending approvals are fetched instead. Only the last 24 hours
 * count, and more than three become one summary.
 */
import { createApi, unwrap, type Api } from '@/shared/api'
import { markTokenLost } from '@/shared/connectionStore'
import { BROWSER_CONTROL, log } from '@/shared/env'
import { withDefaults } from '@/shared/preferences'
import { storage } from '@/shared/storage'
import { updateBadge } from './badge'
import {
  agentRunWorthNotifying,
  catchUp,
  dispose,
  eventTime,
  fromAgentRun,
  fromApprovalRequested,
  fromFocusEnded,
  fromStoredNotification,
  summarize,
  type RunStatusEvent,
  type Spec,
  type StoredNotification,
} from './notify'
import { show } from './notifier'
import { refreshResearch } from './research'
import { handleCommand, isOn as browserOn, type Command } from './browserControl'
import { forgetFocus, onTimerEvent, refreshFocus, setFocusApi, setFocusEndedHandler } from './focus'
import { EventStream, type StreamEvent, type StreamState } from './stream'

const CATCH_UP_WINDOW_MS = 1500
const IDLE_DETECTION_S = 5 * 60

let stream: EventStream | null = null
let streamKey = ''
let api: Api | null = null
/** While catching up after a (re)connect, notifications are collected here first. */
let catchingUp: Spec[] | null = null
let welcomedAt = 0

async function setStreamState(state: StreamState, retryInMs?: number): Promise<void> {
  await storage.set('session', 'stream', { state, at: Date.now(), retryInMs })
}

async function refreshApprovals(): Promise<{ run_id: string; summary: string; created_at: string; conversation_id?: string | null }[]> {
  if (!api) return []
  try {
    const pending = unwrap(await api.GET('/api/approvals'))
    await updateBadge({ approvals: pending.length })
    return pending
  } catch {
    return []
  }
}

async function focusActive(): Promise<boolean> {
  const focus = await storage.get('local', 'focusState')
  return Boolean(focus?.active)
}

async function deliver(spec: Spec): Promise<void> {
  if (catchingUp) {
    catchingUp.push(spec)
    return
  }
  const prefs = withDefaults(await storage.get('local', 'preferences'))
  const what = dispose(spec, prefs, await focusActive())
  if (what === 'show') await show(spec)
  else if (what === 'hold') {
    const held = (await storage.get('local', 'heldNotifications')) ?? []
    await storage.set('local', 'heldNotifications', [...held.filter((h) => h.id !== spec.id), spec].slice(-50))
  }
}

/** Focus ended: what was held back, as one notification (or itself, if just one). */
export async function releaseHeld(): Promise<void> {
  const held = (await storage.get('local', 'heldNotifications')) ?? []
  if (held.length === 0) return
  await storage.set('local', 'heldNotifications', [])
  await show(held.length === 1 ? held[0] : summarize(held, 'held', Date.now()))
}

setFocusEndedHandler((notice) => void deliver(fromFocusEnded(notice, Date.now())))

async function remember(id: string): Promise<void> {
  const seen = await storage.get('local', 'events')
  // Replayed events can be older than what was already seen: never go back.
  const at = Math.max(seen?.lastSeenAt ?? 0, eventTime(id, Date.now()))
  await storage.set('local', 'events', { lastId: id, lastSeenAt: at })
}

async function onEvent(e: StreamEvent): Promise<void> {
  const at = eventTime(e.id, Date.now())
  await remember(e.id)
  switch (e.event) {
    case 'notification': {
      const spec = fromStoredNotification(e.data as unknown as StoredNotification, at)
      if (spec) await deliver(spec)
      break
    }
    case 'approval.requested': {
      const pending = await refreshApprovals()
      const runId = String(e.data.run_id ?? '')
      const summary = pending.find((a) => a.run_id === runId)?.summary ?? null
      // Already answered (e.g. replayed after a reconnect): nothing to ask about.
      if (summary === null && Date.now() - at > 60_000) break
      await deliver(fromApprovalRequested(e.data as { run_id?: string; conversation_id?: string | null }, summary, at))
      break
    }
    case 'run.status': {
      const data = e.data as unknown as RunStatusEvent
      if (data.status !== 'waiting_approval') void refreshApprovals()
      if (!api || data.kind !== 'agent' || !['completed', 'failed'].includes(data.status)) break
      let durationMs: number | null = null
      let title: string | null = null
      try {
        const run = unwrap(await api.GET('/api/runs/{run_id}', { params: { path: { run_id: data.run_id } } }))
        if (run.started_at && run.ended_at) durationMs = Date.parse(run.ended_at) - Date.parse(run.started_at)
        if (data.conversation_id) {
          title = unwrap(await api.GET('/api/conversations/{conversation_id}', { params: { path: { conversation_id: data.conversation_id } } })).title
        }
      } catch {
        // decide with what we know
      }
      const focus = await storage.get('session', 'panelFocus')
      const showing = focus?.visible ? focus.conversationId : null
      if (agentRunWorthNotifying(data, durationMs, showing)) await deliver(fromAgentRun(data, title, at))
      break
    }
    case 'capture.progress':
    case 'capture.finished': {
      // The panel shows these (saving a page or selection).
      const status = e.data as unknown as import('@/shared/storage').CaptureStatus
      const all = (await storage.get('session', 'captures')) ?? {}
      const kept = Object.fromEntries(Object.entries(all).slice(-19))
      await storage.set('session', 'captures', { ...kept, [status.id]: status })
      break
    }
    case 'focus.timer':
      await onTimerEvent(e.data as unknown as import('@/shared/focus').TimerOut)
      break
    case 'research.changed':
      await refreshResearch(api)
      break
    default:
      break
  }
}

/** The stream had a gap (or this is a new connection): fetch what was missed by REST. */
async function fetchMissed(since: number): Promise<void> {
  if (!api || since <= 0) return
  try {
    const list = unwrap(await api.GET('/api/notifications', { params: { query: { unread: true, limit: 50 } } }))
    for (const n of list) {
      const at = Date.parse(n.created_at)
      if (at <= since) continue
      const spec = fromStoredNotification({ id: n.id, title: n.title, body: n.body, kind: n.kind, link: n.link }, at)
      if (spec) catchingUp?.push(spec)
    }
    for (const a of await refreshApprovals()) {
      const at = Date.parse(a.created_at)
      if (at > since) catchingUp?.push(fromApprovalRequested({ run_id: a.run_id, conversation_id: a.conversation_id ?? null }, a.summary, at))
    }
  } catch (err) {
    log.debug('catch-up failed', { kind: (err as { kind?: string }).kind })
  }
}

async function onWelcome(missed: boolean, cursor: string | null): Promise<void> {
  // Before any await: replayed events arrive right behind the welcome.
  catchingUp = []
  welcomedAt = Date.now()
  const seen = (await storage.get('local', 'events')) ?? { lastId: null, lastSeenAt: 0 }
  if (!seen.lastId && cursor) await storage.set('local', 'events', { lastId: cursor, lastSeenAt: seen.lastSeenAt })
  if (seen.lastSeenAt === 0) {
    // The first connection ever: nothing to catch up on.
    await storage.set('local', 'events', { lastId: seen.lastId ?? cursor, lastSeenAt: welcomedAt })
  } else if (missed || !seen.lastId) {
    await fetchMissed(seen.lastSeenAt)
  }
  void refreshApprovals()
  void refreshResearch(api)
  void refreshFocus()
  setTimeout(() => void flushCatchUp(), CATCH_UP_WINDOW_MS)
}

async function flushCatchUp(): Promise<void> {
  const collected = catchingUp ?? []
  catchingUp = null
  for (const spec of catchUp(collected, Date.now())) await deliver(spec)
}

async function presence(): Promise<{ active: boolean; discord_skip: boolean } | null> {
  const prefs = withDefaults(await storage.get('local', 'preferences'))
  if (!prefs.features.discordSkip) return { active: false, discord_skip: false }
  if (!chrome.idle) return null // permission not granted (yet)
  chrome.idle.setDetectionInterval(IDLE_DETECTION_S)
  const state = await chrome.idle.queryState(IDLE_DETECTION_S)
  return { active: state === 'active', discord_skip: true }
}

/** Connect, reconnect or disconnect to match the saved connection. Safe to call often. */
export async function syncStream(): Promise<void> {
  const connection = await storage.get('local', 'connection')
  const key = connection?.token ? `${connection.serverUrl} ${connection.token}` : ''
  if (key && key === streamKey && stream) return
  stream?.stop()
  stream = null
  streamKey = key
  api = null
  if (!connection?.token) {
    await updateBadge({ approvals: 0 })
    await refreshResearch(null)
    setFocusApi(null)
    await forgetFocus()
    return
  }
  api = createApi({ serverUrl: connection.serverUrl, token: connection.token, onUnauthorized: () => void markTokenLost() })
  setFocusApi(api)
  const seen = await storage.get('local', 'events')
  stream = new EventStream({
    serverUrl: connection.serverUrl,
    token: connection.token,
    lastId: seen?.lastId ?? null,
    version: chrome.runtime.getManifest().version,
    onEvent: (e) => void onEvent(e),
    onWelcome: (missed, cursor) => void onWelcome(missed, cursor),
    onState: (state, detail) => {
      void setStreamState(state, detail?.retryInMs)
      if (state === 'unauthorized') void markTokenLost()
    },
    presence,
    // Browser control: offered while switched on (and its permissions are given).
    browserOffer: async () => BROWSER_CONTROL && withDefaults(await storage.get('local', 'preferences')).features.browserControl && (await browserOn()),
    onCommand: (command) => {
      const current = stream
      void handleCommand(command as unknown as Command, (reply) => void current?.send(reply))
    },
  })
  stream.start()
}

/** The idle state changed (or the Discord option): tell Anemo now, not in 30 s. */
export function presenceChanged(): void {
  void stream?.sendPresence()
}

export function isStreamConnected(): boolean {
  return stream?.connected ?? false
}
