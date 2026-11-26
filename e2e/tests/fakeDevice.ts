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
  /** It takes messages while it runs (code-sessions.md §15, Anemo Desktop 1.9.0). */
  input?: boolean
}

/** A `device.command` as the server sends it. */
export type FakeCommand = { id: string; action: string; [key: string]: unknown }

export class FakeComputer {
  private acks = new Map<string, number>()
  private waiters: Array<() => void> = []
  /** Every command the server sent, in order. */
  readonly commands: FakeCommand[] = []
  /** Answers a command (its `state`); throwing answers it as failed. Unset: every command fails. */
  answer: ((command: FakeCommand) => object) | null = null

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
      if (msg.type === 'device.command') {
        const command = msg as unknown as FakeCommand
        this.commands.push(command)
        for (const wake of this.waiters.splice(0)) wake()
        try {
          if (!this.answer) throw new Error('This fake computer answers no commands.')
          this.send({ type: 'device.result', id: command.id, ok: true, state: this.answer(command) })
        } catch (err) {
          this.send({ type: 'device.result', id: command.id, ok: false, code: 'failed', error: String((err as Error).message) })
        }
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

  /** Sends an offer: what this computer lets Anemo do (sharing jobs is always on here). */
  offer(fields: { control?: boolean; code_start?: boolean; code_input?: boolean }) {
    this.send({ type: 'device.offer', control: false, shell: false, code: true, ...fields })
  }

  /** The first command with this action, once it came; throws after `timeoutMs`. */
  async command(action: string, timeoutMs = 10_000): Promise<FakeCommand> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = this.commands.find((c) => c.action === action)
      if (found) return found
      const left = deadline - Date.now()
      if (left <= 0) throw new Error(`no ${action} command came`)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left)
        this.waiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
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
