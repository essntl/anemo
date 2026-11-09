/**
 * The authenticated event stream to Anemo (backend: features/extension/router.py), kept
 * open by the service worker. Chrome (116+) keeps an extension worker alive while its
 * WebSocket is active, so a ping every 20 s keeps both the worker and the proxies
 * (Nginx Proxy Manager, Cloudflare's ~100 s idle limit) awake.
 *
 * Reconnects with exponential backoff (1 s doubling to 60 s, with jitter) and resumes from
 * the last event id. A revoked token (close 4401) or a refusal (4403) stops it for good:
 * those need the user, not a retry.
 */

export interface WebSocketLike {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: { code: number; reason?: string }) => void) | null
  onerror: ((ev: unknown) => void) | null
}

export interface StreamEvent {
  id: string
  event: string
  data: Record<string, unknown>
}

export type StreamState = 'connecting' | 'connected' | 'waiting' | 'stopped' | 'unauthorized' | 'refused'

export interface StreamOptions {
  serverUrl: string
  token: string
  lastId: string | null
  version: string
  onEvent: (e: StreamEvent) => void
  onWelcome: (missed: boolean, cursor: string | null) => void
  onState: (state: StreamState, detail?: { retryInMs?: number }) => void
  /** What to report about you being at the computer, or null to report nothing. */
  presence: () => Promise<{ active: boolean; discord_skip: boolean } | null>
}

export interface StreamDeps {
  connect: (url: string) => WebSocketLike
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  random: () => number
}

const defaultDeps: StreamDeps = {
  connect: (url) => new WebSocket(url) as unknown as WebSocketLike,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  random: Math.random,
}

export const PING_MS = 20_000
export const PRESENCE_MS = 30_000
/** No message at all for this long: the connection is dead even if not closed. */
export const SILENCE_MS = 50_000
export const MAX_BACKOFF_MS = 60_000
export const CLOSE_UNAUTHORIZED = 4401
export const CLOSE_REFUSED = 4403

export function wsUrl(serverUrl: string): string {
  const url = new URL(serverUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/api/extension/ws'
  return url.toString()
}

/** Delay before reconnect attempt n (1-based): 1 s, 2 s, 4 s … 60 s, times 0.5–1 jitter. */
export function backoff(attempt: number, random: () => number): number {
  const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (attempt - 1))
  return Math.round(base * (0.5 + random() / 2))
}

export class EventStream {
  private ws: WebSocketLike | null = null
  private attempt = 0
  private stopped = false
  private lastId: string | null
  private timers: unknown[] = []
  private retryTimer: unknown = null
  private silenceTimer: unknown = null
  private readonly deps: StreamDeps

  constructor(private readonly opts: StreamOptions, deps: Partial<StreamDeps> = {}) {
    this.deps = { ...defaultDeps, ...deps }
    this.lastId = opts.lastId
  }

  get connected(): boolean {
    return this.ws?.readyState === 1
  }

  start(): void {
    this.stopped = false
    this.open()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    if (this.retryTimer) this.deps.clearTimeout(this.retryTimer)
    this.retryTimer = null
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onclose = null
      ws.close(1000, 'stopped')
    }
    this.opts.onState('stopped')
  }

  /** Report presence now (e.g. the idle state just changed). */
  async sendPresence(): Promise<void> {
    const p = await this.opts.presence()
    if (p && this.connected) this.ws?.send(JSON.stringify({ type: 'presence', ...p }))
  }

  private open(): void {
    if (this.stopped) return
    this.opts.onState('connecting')
    let ws: WebSocketLike
    try {
      ws = this.deps.connect(wsUrl(this.opts.serverUrl))
    } catch {
      this.retry()
      return
    }
    this.ws = ws
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', token: this.opts.token, last_id: this.lastId, version: this.opts.version }))
      this.heard()
    }
    ws.onmessage = (ev) => this.onMessage(ev.data)
    ws.onerror = () => undefined // onclose follows and decides
    ws.onclose = (ev) => this.onClose(ev.code)
  }

  private onMessage(raw: unknown): void {
    this.heard()
    if (typeof raw !== 'string') return
    let message: { type?: string; id?: string; event?: string; data?: Record<string, unknown>; missed?: boolean; cursor?: string }
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (message.type === 'welcome') {
      this.attempt = 0
      // Where the server starts relaying: a reconnect resumes from here even when no event
      // came in before the connection dropped.
      const cursor = typeof message.cursor === 'string' && message.cursor !== '$' ? message.cursor : null
      if (cursor && !this.lastId) this.lastId = cursor
      this.opts.onState('connected')
      this.opts.onWelcome(Boolean(message.missed), cursor)
      this.startTimers()
      void this.sendPresence()
    } else if (message.type === 'event' && typeof message.id === 'string' && typeof message.event === 'string') {
      this.lastId = message.id
      this.opts.onEvent({ id: message.id, event: message.event, data: message.data ?? {} })
    }
  }

  private onClose(code: number): void {
    this.clearTimers()
    this.ws = null
    if (this.stopped) return
    if (code === CLOSE_UNAUTHORIZED) {
      this.stopped = true
      this.opts.onState('unauthorized')
      return
    }
    if (code === CLOSE_REFUSED) {
      this.stopped = true
      this.opts.onState('refused')
      return
    }
    this.retry()
  }

  private retry(): void {
    if (this.stopped) return
    this.attempt += 1
    const delay = backoff(this.attempt, this.deps.random)
    this.opts.onState('waiting', { retryInMs: delay })
    this.retryTimer = this.deps.setTimeout(() => {
      this.retryTimer = null
      this.open()
    }, delay)
  }

  /** Any message resets the silence watchdog. */
  private heard(): void {
    if (this.silenceTimer) this.deps.clearTimeout(this.silenceTimer)
    this.silenceTimer = this.deps.setTimeout(() => {
      // Nothing for too long (a half-open connection): drop it and reconnect.
      this.ws?.close(4000, 'silent')
    }, SILENCE_MS)
  }

  private startTimers(): void {
    this.clearPeriodic()
    const ping = () => {
      if (this.connected) this.ws?.send(JSON.stringify({ type: 'ping' }))
      this.timers.push(this.deps.setTimeout(ping, PING_MS))
    }
    const presence = () => {
      void this.sendPresence()
      this.timers.push(this.deps.setTimeout(presence, PRESENCE_MS))
    }
    this.timers.push(this.deps.setTimeout(ping, PING_MS))
    this.timers.push(this.deps.setTimeout(presence, PRESENCE_MS))
  }

  private clearPeriodic(): void {
    for (const t of this.timers) this.deps.clearTimeout(t)
    this.timers = []
  }

  private clearTimers(): void {
    this.clearPeriodic()
    if (this.silenceTimer) this.deps.clearTimeout(this.silenceTimer)
    this.silenceTimer = null
  }
}
