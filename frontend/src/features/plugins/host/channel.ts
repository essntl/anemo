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
 *   4. `ui.*`, `context.get` and `layout.get` are answered here; everything else goes to the server
 *      (`POST /api/plugins/{id}/call`), which checks it all again.
 *   5. If the server says the call needs the user's OK (`confirm_required`), Anemo's own
 *      dialog asks; "Allow" sends the call again with the one-time token. The token stays
 *      in this file: it is never put into a message to the frame.
 *
 * An overlay frame's bootstrap also sends `{pointer: {x, y} | null}` (where the pointer is
 * while the frame has it): not a request, so it gets no answer and isn't rate limited.
 *
 * No React and no DOM here (only the port), so the rules can be tested on their own.
 */
import { ApiError } from '@/api/client'
import type { PluginCallBody, Risk, Slot } from '../types'
import type { LayoutInfo, Rect } from './layout'
import { checkCall, type FrameError, type FrameErrorCode, isLocal, OPEN_NEEDS } from './methods'
import { MAX_PICK_BYTES, PICKABLE_TYPES, PickError, type PickedFile, type PickOptions } from './pickFile'

/** Requests a frame may send in a minute, and how many may wait for an answer at once. */
export const RATE_PER_MINUTE = 120
export const MAX_IN_FLIGHT = 8
/** The largest message, in characters of JSON (contract: 1 MB). */
export const MAX_MESSAGE = 1_000_000
/** assets.set carries a picture of up to 10 MB as a base64 data: URL. */
export const MAX_ASSET_MESSAGE = 13_980_000
/** An overlay's hit regions: how many, and how large each may be (CSS pixels). */
export const MAX_HIT_REGIONS = 8
export const MAX_HIT_SIZE = 320
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
  /** Overlay frames: where the frame takes the pointer (already checked), and whether it shows. */
  setHitRegions?: (regions: Rect[]) => void
  setVisible?: (visible: boolean) => void
  /** Overlay frames: where the pointer is in the frame while it has it (null: it left). */
  pointer?: (point: { x: number; y: number } | null) => void
  /** Opens the browser's file picker (pickFile.ts); rejects with a PickError. */
  pickFile?: (options: PickOptions) => Promise<PickedFile>
  layout?: () => LayoutInfo
  /** A write to the plugin's own storage or assets went through: tell its other frames. */
  wrote?: (area: 'storage' | 'assets', key: string) => void
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
    if (this.pointerReport(data)) return
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
    if (size > (method === 'assets.set' ? MAX_ASSET_MESSAGE : MAX_MESSAGE)) {
      return this.reply(id, { error: { code: 'invalid_params', message: method === 'assets.set' ? 'An asset may be at most 10 MB.' : 'A message may be at most 1 MB.' } })
    }
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      return this.reply(id, { error: { code: 'invalid_params', message: 'The params must be an object.' } })
    }
    const refused = checkCall(method, params, o.permissions)
    if (refused) return this.reply(id, { error: refused })

    this.inFlight++
    try {
      const p = params as Record<string, unknown>
      const result = isLocal(method) ? await this.local(method, p) : await this.remote(method, p)
      this.wroteOwn(method, p)
      this.reply(id, { result: result ?? null })
    } catch (err) {
      this.reply(id, { error: err instanceof FrameFailure || err instanceof PickError ? { code: err.code, message: err.message } : frameError(err) })
    } finally {
      this.inFlight--
    }
  }

  private remote(method: string, params: Record<string, unknown>): Promise<unknown> {
    const o = this.options
    const body: PluginCallBody = { ui: o.ui, method, params, ...(o.previewVersion ? { preview_version: o.previewVersion } : {}) }
    return callWithConfirm(body, o.call, o.confirm)
  }

  /** An overlay's report of the pointer (see the top of this file); true when it was one. */
  private pointerReport(data: unknown): boolean {
    if (!data || typeof data !== 'object' || !('pointer' in data) || 'method' in data) return false
    if (this.closed || this.options.slot !== 'overlay') return true
    const point = (data as { pointer: unknown }).pointer
    if (point === null) this.options.pointer?.(null)
    else if (point && typeof point === 'object') {
      const { x, y } = point as { x?: unknown; y?: unknown }
      if (finite(x) && finite(y)) this.options.pointer?.({ x, y })
    }
    return true
  }

  /** After a write to the plugin's own data: its other frames hear about it. */
  private wroteOwn(method: string, p: Record<string, unknown>): void {
    const area = WRITES[method]
    if (area && typeof p.key === 'string') this.options.wrote?.(area, p.key)
  }

  /** The methods the page answers itself. Throws a FrameFailure when the params are wrong. */
  private async local(method: string, p: Record<string, unknown>): Promise<unknown> {
    const o = this.options
    if (method === 'context.get') return o.context()
    if (method === 'layout.get') {
      onlyParams(method, p, [])
      return o.layout?.() ?? null
    }
    if (method === 'ui.setHitRegions') {
      const regions = parseHitRegions(p)
      if (o.slot !== 'overlay' || !o.setHitRegions) throw invalidParams('Only an overlay has hit regions.')
      o.setHitRegions(regions)
      return {}
    }
    if (method === 'ui.setVisible') {
      onlyParams(method, p, ['visible'])
      if (typeof p.visible !== 'boolean') throw invalidParams('ui.setVisible needs "visible": true or false.')
      if (o.slot !== 'overlay' || !o.setVisible) throw invalidParams('Only an overlay can hide and show itself.')
      o.setVisible(p.visible)
      return {}
    }
    if (method === 'ui.pickFile') {
      const options = parsePickOptions(p)
      if (!o.pickFile) throw new FrameFailure('unavailable', 'Files can’t be picked here.')
      return o.pickFile(options)
    }
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

/** The methods that write the plugin's own data, and which kind. */
const WRITES: Record<string, 'storage' | 'assets'> = {
  'storage.set': 'storage',
  'storage.delete': 'storage',
  'assets.set': 'assets',
  'assets.delete': 'assets',
}

/** Unknown parameters are an error, as on the server (a typo shouldn't silently do nothing). */
function onlyParams(method: string, p: Record<string, unknown>, known: string[]): void {
  const unknown = Object.keys(p).filter((k) => !known.includes(k))
  if (unknown.length) throw invalidParams(`${method} has no parameter "${unknown[0]}".`)
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** `ui.setHitRegions`' params, checked: at most 8 rectangles, each at most 320 × 320. */
export function parseHitRegions(p: Record<string, unknown>): Rect[] {
  onlyParams('ui.setHitRegions', p, ['regions'])
  if (!Array.isArray(p.regions)) throw invalidParams('ui.setHitRegions needs "regions": a list of {x, y, width, height}.')
  if (p.regions.length > MAX_HIT_REGIONS) throw invalidParams(`At most ${MAX_HIT_REGIONS} hit regions.`)
  return p.regions.map((r: unknown, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw invalidParams(`regions[${i}] must be {x, y, width, height}.`)
    const region = r as Record<string, unknown>
    const extra = Object.keys(region).find((k) => !['x', 'y', 'width', 'height'].includes(k))
    if (extra) throw invalidParams(`regions[${i}] has no field "${extra}".`)
    const { x, y, width, height } = region
    if (!finite(x) || !finite(y) || !finite(width) || !finite(height)) throw invalidParams(`regions[${i}] needs numbers x, y, width and height.`)
    if (width <= 0 || height <= 0 || width > MAX_HIT_SIZE || height > MAX_HIT_SIZE) {
      throw invalidParams(`regions[${i}] must be larger than 0 and at most ${MAX_HIT_SIZE} × ${MAX_HIT_SIZE} pixels.`)
    }
    return { x, y, width, height }
  })
}

/** Whether a point is inside one of the regions. */
export function inRegions(regions: readonly Rect[], x: number, y: number): boolean {
  return regions.some((r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)
}

/** `ui.pickFile`'s params, checked: picture types only, at most 10 MB. */
export function parsePickOptions(p: Record<string, unknown>): PickOptions {
  onlyParams('ui.pickFile', p, ['accept', 'maxBytes'])
  const types: readonly string[] = PICKABLE_TYPES
  let accept: string[] = [...PICKABLE_TYPES]
  if (p.accept !== undefined) {
    if (!Array.isArray(p.accept) || !p.accept.length || !p.accept.every((a) => typeof a === 'string' && types.includes(a))) {
      throw invalidParams(`"accept" is a list of ${PICKABLE_TYPES.join(', ')} (pictures only).`)
    }
    accept = [...new Set(p.accept as string[])]
  }
  let maxBytes = MAX_PICK_BYTES
  if (p.maxBytes !== undefined) {
    if (!finite(p.maxBytes) || p.maxBytes <= 0) throw invalidParams('"maxBytes" is a number of bytes.')
    maxBytes = Math.min(MAX_PICK_BYTES, Math.floor(p.maxBytes))
  }
  return { accept, maxBytes }
}

/** A refusal of the page's own (wrong params, a page that doesn't exist), sent to the frame as it is. */
class FrameFailure extends Error {
  readonly code: FrameErrorCode
  constructor(code: FrameErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

const invalidParams = (message: string) => new FrameFailure('invalid_params', message)
