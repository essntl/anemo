/**
 * Server-Sent Events over fetch. EventSource can't send an Authorization header, so the
 * extension reads Anemo's SSE streams with fetch and parses them here. It reconnects with
 * `Last-Event-ID` after a dropped connection, as EventSource would.
 */

export interface SseEvent {
  id: string | null
  type: string
  data: string
}

/** Incremental parser: feed it chunks, it returns the complete events so far. */
export class SseParser {
  private buffer = ''
  private id: string | null = null
  private type = ''
  private data: string[] = []

  push(chunk: string): SseEvent[] {
    this.buffer += chunk
    const out: SseEvent[] = []
    let newline: number
    while ((newline = this.buffer.search(/\r\n|\r|\n/)) !== -1) {
      const line = this.buffer.slice(0, newline)
      const sep = this.buffer.startsWith('\r\n', newline) ? 2 : 1
      this.buffer = this.buffer.slice(newline + sep)
      if (line === '') {
        if (this.data.length > 0) out.push({ id: this.id, type: this.type || 'message', data: this.data.join('\n') })
        this.type = ''
        this.data = []
        continue
      }
      if (line.startsWith(':')) continue // a comment (keep-alive)
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      let value = colon === -1 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'data') this.data.push(value)
      else if (field === 'event') this.type = value
      else if (field === 'id') this.id = value || null
    }
    return out
  }
}

export interface StreamOptions {
  url: string
  headers: Record<string, string>
  signal: AbortSignal
  onEvent: (event: SseEvent) => void
  /** Called after each (re)connect attempt fails; return false to give up. */
  onError?: (err: unknown, attempt: number) => boolean
  /** A response that isn't an event stream: return the error to throw (the stream stops). */
  check?: (res: Response) => Promise<Error | null>
  /** Delay before reconnect attempt n (1-based). */
  backoffMs?: (attempt: number) => number
  /** Resume after this id (the last one seen). */
  lastEventId?: string | null
  /** Stop when this returns true for an event (e.g. a terminal run status). */
  isEnd?: (event: SseEvent) => boolean
}

export const defaultBackoff = (attempt: number): number => Math.min(30_000, 500 * 2 ** (attempt - 1))

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/** Reads the stream until it ends (isEnd), the signal aborts, or onError gives up. */
export async function readStream(opts: StreamOptions): Promise<void> {
  let lastId = opts.lastEventId ?? null
  let attempt = 0
  while (!opts.signal.aborted) {
    try {
      const headers: Record<string, string> = { Accept: 'text/event-stream', ...opts.headers }
      if (lastId) headers['Last-Event-ID'] = lastId
      const res = await fetch(opts.url, { headers, signal: opts.signal, credentials: 'omit', cache: 'no-store' })
      const problem = opts.check ? await opts.check(res) : null
      if (problem) throw problem
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      attempt = 0
      const parser = new SseParser()
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        for (const event of parser.push(value)) {
          if (event.id) lastId = event.id
          opts.onEvent(event)
          if (opts.isEnd?.(event)) {
            await reader.cancel().catch(() => undefined)
            return
          }
        }
      }
      // The server closed the stream without an end: reconnect.
      throw new Error('stream closed')
    } catch (err) {
      if (opts.signal.aborted) return
      attempt += 1
      if (opts.onError && !opts.onError(err, attempt)) return
      await sleep((opts.backoffMs ?? defaultBackoff)(attempt), opts.signal)
    }
  }
}
