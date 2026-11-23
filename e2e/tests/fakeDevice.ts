import type { APIRequestContext } from '@playwright/test'

/*
 * A fake Anemo Desktop for e2e tests: a computer device made through the API, connected
 * to the device WebSocket (docs/device-contracts.md §2) with Node's own WebSocket, which
 * sends no Origin header, as a native client. It speaks just enough of the protocol to
 * share Claude Code jobs (§7): hello, an offer, code.job, code.events, and it collects
 * the server's code.ack messages.
 *
 * The request context must be logged in with a fresh password confirmation (just after
 * login), since adding a device needs one.
 */

type Message = { type: string; [key: string]: unknown }

export interface FakeJob {
  id: string
  device_job_dir: string
  project: string
  dir: string
  started: string
  prompt: string
  resume_session: string | null
  model: string | null
  pid: number | null
  state: 'running' | 'done' | 'failed' | 'cancelled' | 'exited_without_result'
  ended: string | null
  branch: string | null
  stderr_tail: string | null
}

export class FakeComputer {
  private acks = new Map<string, number>()
  private waiters: Array<() => void> = []

  private constructor(
    private readonly request: APIRequestContext,
    readonly id: string,
    readonly name: string,
    private readonly ws: WebSocket,
  ) {
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(String(e.data)) as Message
      if (msg.type === 'code.ack') {
        this.acks.set(String(msg.job_id), Number(msg.seq))
        for (const wake of this.waiters.splice(0)) wake()
      }
    })
  }

  /** Adds a computer named `name` and connects it; `trust` as in Settings → Devices. */
  static async connect(
    request: APIRequestContext,
    baseURL: string,
    name: string,
    trust: 'trusted' | 'watched' = 'trusted',
  ): Promise<FakeComputer> {
    const made = await request.post('/api/devices', { data: { name, kind: 'computer', trust } })
    if (!made.ok()) throw new Error(`adding the device failed: ${made.status()} ${await made.text()}`)
    const device = (await made.json()) as { id: string; token: string }
    const url = new URL('/api/devices/ws', baseURL)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true })
      ws.addEventListener('error', () => reject(new Error('the device WebSocket did not open')), { once: true })
    })
    const welcome = new Promise<Message>((resolve) => {
      const onMessage = (e: MessageEvent) => {
        const msg = JSON.parse(String(e.data)) as Message
        if (msg.type === 'welcome') {
          ws.removeEventListener('message', onMessage)
          resolve(msg)
        }
      }
      ws.addEventListener('message', onMessage)
    })
    ws.send(JSON.stringify({ type: 'hello', token: device.token, kind: 'computer', version: '1.1.0', last_id: null }))
    await welcome
    const computer = new FakeComputer(request, device.id, name, ws)
    computer.send({ type: 'device.offer', control: false, shell: false, code: true })
    return computer
  }

  send(message: Message) {
    this.ws.send(JSON.stringify(message))
  }

  /** Announces a job (or its new state). */
  job(job: FakeJob) {
    this.send({ type: 'code.job', job })
  }

  /** Sends events with seq numbers from `firstSeq`. */
  events(jobId: string, firstSeq: number, events: object[]) {
    this.send({
      type: 'code.events',
      job_id: jobId,
      events: events.map((event, i) => ({ seq: firstSeq + i, event, trimmed: false })),
    })
  }

  /** The last ack for the job, once it is at least `seq`; throws after `timeoutMs`. */
  async ackAtLeast(jobId: string, seq: number, timeoutMs = 10_000): Promise<number> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const have = this.acks.get(jobId)
      if (have !== undefined && have >= seq) return have
      const left = deadline - Date.now()
      if (left <= 0) throw new Error(`no ack ≥ ${seq} for ${jobId} (last: ${have ?? 'none'})`)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left)
        this.waiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }

  /** The last ack seen for the job, if any. */
  lastAck(jobId: string): number | undefined {
    return this.acks.get(jobId)
  }

  /** Closes the connection and deletes the device (its jobs go with it). */
  async remove() {
    this.ws.close()
    await this.request.delete(`/api/devices/${this.id}`)
  }
}

/** A job id as cc.ps1 makes them: yyyyMMdd-HHmmss-xxxx. */
export function jobId(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${rand}`
}
