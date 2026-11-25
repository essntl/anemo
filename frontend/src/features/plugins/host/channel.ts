/**
 * The host's end of one plugin frame's MessagePort (contract §6.2–§6.4).
 *
 * A frame sends requests `{id, method, params}` and gets exactly one answer per request,
 * `{id, result}` or `{id, error: {code, message}}`; the host also sends events
 * `{event, data}`. For every request, in this order:
 *
 *   1. Is the plugin still allowed to run (enabled or a preview; kill switch off)?
 *   2. Rate limit: at most 120 requests a minute and 8 waiting at once, per frame.
 *   3. Does the method exist, and does the approved manifest (or the preview's) allow it?
 *   4. `ui.*` and `context.get` are answered here; everything else goes to the server
 *      (`POST /api/plugins/{id}/call`), which checks it all again.
 *   5. If the server says the call needs the user's OK (`confirm_required`), Anemo's own
 *      dialog asks; "Allow" sends the call again with the one-time token. The token stays
 *      in this file: it is never put into a message to the frame.
 *
 * No React and no DOM here (only the port), so the rules can be tested on their own.
 */
import { ApiError } from '@/api/client'
import type { PluginCallBody } from '../api'
import type { Risk, Slot } from '../types'
import { checkCall, type FrameError, type FrameErrorCode, isLocal, OPEN_NEEDS } from './methods'

/** Requests a frame may send in a minute, and how many may wait for an answer at once. */
export const RATE_PER_MINUTE = 120
export const MAX_IN_FLIGHT = 8
/** The largest message, in characters of JSON (contract: 1 MB). */
export const MAX_MESSAGE = 1_000_000
/** What `ui.resize` may ask for, in CSS pixels. */
export const MIN_HEIGHT = 40
export const MAX_HEIGHT = 2000

/** What the server says a call needs the user's OK for (the `details` of `confirm_required`). */
export interface ConfirmRequest {
  summary: string
  risk: Risk
}

/** The part of a MessagePort the channel uses (a fake one in tests). */
export interface PortLike {
  postMessage: (message: unknown) => void
  addEventListener: (type: 'message', listener: (event: MessageEvent) => void) => void
  removeEventListener: (type: 'message', listener: (event: MessageEvent) => void) => void
  start?: () => void
  close?: () => void
}

export interface ChannelOptions {
  pluginId: string
  ui: string
  slot: Slot
  /** The permissions of the version that runs (or of the previewed version). */
  permissions: readonly string[]
  /** The ids of this plugin's own pages, which `ui.open` may open. */
  pages: readonly string[]
  /** Set for a preview: the version being tried (sent with every call). */
  previewVersion: string | null
  /** Whether the plugin may run right now (enabled or a preview, kill switch off). */
  active: () => boolean
  context: () => unknown
  /** Sends a call to the server; throws ApiError. */
  call: (body: PluginCallBody) => Promise<unknown>
  /** Asks the user (Anemo's own dialog); true = Allow. */
  confirm: (request: ConfirmRequest) => Promise<boolean>
  resize: (height: number) => void
  toast: (message: string, tone: string) => void
  open: (type: 'task' | 'document' | 'event' | 'page', id: string) => void
  now?: () => number
}

interface Request {
  id: number | string
  method: string
  params: unknown
}

const FRAME_CODES: FrameErrorCode[] = ['permission_denied', 'not_found', 'invalid_params', 'declined', 'rate_limited', 'unavailable', 'failed', 'unknown_method']

/** The server's error as one of the codes a frame knows. */
export function frameError(err: unknown): FrameError {
  if (err instanceof ApiError) {
    if ((FRAME_CODES as string[]).includes(err.code)) return { code: err.code as FrameErrorCode, message: err.message }
    if (err.code === 'plugins_disabled' || err.code === 'plugin_disabled' || err.status === 503) return { code: 'unavailable', message: err.message }
    if (err.status === 403) return { code: 'permission_denied', message: err.message }
    if (err.status === 404) return { code: 'not_found', message: err.message }
    if (err.status === 422 || err.status === 400) return { code: 'invalid_params', message: err.message }
    if (err.status === 429) return { code: 'rate_limited', message: err.message }
    return { code: 'failed', message: err.message }
  }
  // fetch itself failed: the server can't be reached.
  return { code: 'unavailable', message: 'Anemo’s server could not be reached.' }
}

/**
 * Sends a call to the server and, when it needs the user's OK, asks and sends it again with
 * the token. Shared by the frames and by plugin commands in Ctrl+K.
 */
export async function callWithConfirm(
  body: PluginCallBody,
  call: (body: PluginCallBody) => Promise<unknown>,
  confirm: (request: ConfirmRequest) => Promise<boolean>,
): Promise<unknown> {
  try {
    return await call(body)
  } catch (err) {
    if (!(err instanceof ApiError && err.code === 'confirm_required')) throw err
    const details = (err.details ?? {}) as { token?: unknown; summary?: unknown; risk?: unknown }
    if (typeof details.token !== 'string') throw err
    const risk = (['low', 'medium', 'high', 'critical'] as const).find((r) => r === details.risk) ?? 'high'
    const allowed = await confirm({ summary: typeof details.summary === 'string' ? details.summary : err.message, risk })
    if (!allowed) throw new ApiError(403, 'declined', 'The user said no.')
    // The same call once more, with the token bound to exactly this call.
    return call({ ...body, confirm_token: details.token })
  }
}

export class PluginChannel {
  private readonly port: PortLike
  private readonly options: ChannelOptions
  private readonly sent: number[] = []
  private inFlight = 0
  private closed = false
  private readonly listener = (event: MessageEvent) => void this.receive(event.data)

  constructor(port: PortLike, options: ChannelOptions) {
    this.port = port
    this.options = options
    port.addEventListener('message', this.listener)
    port.start?.()
  }

  /** An event for the frame (theme.changed, context.changed, object.changed). */
  emit(event: string, data: unknown): void {
    if (!this.closed) this.port.postMessage({ event, data })
  }

  close(): void {
    this.closed = true
    this.port.removeEventListener('message', this.listener)
    this.port.close?.()
  }

  private reply(id: Request['id'], answer: { result: unknown } | { error: FrameError }): void {
    if (!this.closed) this.port.postMessage({ id, ...answer })
  }

  /** The request in a message, or null when it isn't one (then there is no id to answer). */
  private parse(data: unknown): Request | null {
    if (!data || typeof data !== 'object') return null
    const d = data as Record<string, unknown>
    if ((typeof d.id !== 'number' && typeof d.id !== 'string') || typeof d.method !== 'string') return null
    return { id: d.id, method: d.method, params: d.params ?? {} }
  }

  /** Counts the request against the rate limit; false when over it. */
  private withinRate(): boolean {
    const now = (this.options.now ?? Date.now)()
    while (this.sent.length && now - this.sent[0] >= 60_000) this.sent.shift()
    if (this.sent.length >= RATE_PER_MINUTE || this.inFlight >= MAX_IN_FLIGHT) return false
    this.sent.push(now)
    return true
  }

  async receive(data: unknown): Promise<void> {
    const request = this.parse(data)
    if (!request || this.closed) return
    const { id, method, params } = request
    const o = this.options

    if (!o.active()) return this.reply(id, { error: { code: 'unavailable', message: 'This plugin is turned off.' } })
    if (!this.withinRate()) return this.reply(id, { error: { code: 'rate_limited', message: `At most ${RATE_PER_MINUTE} requests a minute and ${MAX_IN_FLIGHT} at once.` } })
    let size = 0
    try {
      size = JSON.stringify(params).length
    } catch {
      return this.reply(id, { error: { code: 'invalid_params', message: 'The params must be plain JSON.' } })
    }
    if (size > MAX_MESSAGE) return this.reply(id, { error: { code: 'invalid_params', message: 'A message may be at most 1 MB.' } })
    const refused = checkCall(method, params, o.permissions)
    if (refused) return this.reply(id, { error: refused })

    this.inFlight++
    try {
      const result = isLocal(method) ? this.local(method, params as Record<string, unknown>) : await this.remote(method, params)
      this.reply(id, { result: result ?? null })
    } catch (err) {
      this.reply(id, { error: err instanceof FrameFailure ? { code: err.code, message: err.message } : frameError(err) })
    } finally {
      this.inFlight--
    }
  }

  private remote(method: string, params: unknown): Promise<unknown> {
    const o = this.options
    const body: PluginCallBody = { ui: o.ui, method, params, ...(o.previewVersion ? { preview_version: o.previewVersion } : {}) }
    return callWithConfirm(body, o.call, o.confirm)
  }

  /** The methods the page answers itself. Throws a FrameFailure when the params are wrong. */
  private local(method: string, p: Record<string, unknown>): unknown {
    const o = this.options
    if (method === 'context.get') return o.context()
    if (method === 'ui.resize') {
      if (typeof p.height !== 'number' || !Number.isFinite(p.height)) throw invalidParams('ui.resize needs a "height" in pixels.')
      // Pages and the settings tab take the room they are given; panels and blocks can grow.
      if (o.slot === 'object.panel' || o.slot === 'chat.block') o.resize(clampHeight(p.height))
      return {}
    }
    if (method === 'ui.toast') {
      if (typeof p.message !== 'string' || !p.message.trim()) throw invalidParams('ui.toast needs a "message".')
      // Plain text only, and short: a notice, not a place for a page of content.
      o.toast(p.message.trim().slice(0, 200), typeof p.tone === 'string' ? p.tone : 'info')
      return {}
    }
    // ui.open
    const type = p.type
    const target = p.id
    if (typeof target !== 'string' || !target) throw invalidParams('ui.open needs an "id".')
    if (type === 'page') {
      if (!o.pages.includes(target)) throw new FrameFailure('not_found', `This plugin has no page "${target}".`)
      o.open('page', target)
      return {}
    }
    if (type !== 'task' && type !== 'document' && type !== 'event') throw invalidParams('ui.open opens a "task", "document", "event" or "page".')
    if (!o.permissions.includes(OPEN_NEEDS[type])) throw new FrameFailure('permission_denied', `Opening a ${type} needs "${OPEN_NEEDS[type]}".`)
    o.open(type, target)
    return {}
  }
}

export const clampHeight = (height: number): number => Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, height)))

/** A refusal of the page's own (wrong params, a page that doesn't exist), sent to the frame as it is. */
class FrameFailure extends Error {
  readonly code: FrameErrorCode
  constructor(code: FrameErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

const invalidParams = (message: string) => new FrameFailure('invalid_params', message)
