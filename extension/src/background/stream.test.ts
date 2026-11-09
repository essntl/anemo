import { describe, expect, it, vi } from 'vitest'
import { backoff, CLOSE_REFUSED, CLOSE_UNAUTHORIZED, EventStream, PING_MS, SILENCE_MS, wsUrl, type StreamOptions, type WebSocketLike } from './stream'

class FakeSocket implements WebSocketLike {
  readyState = 0
  sent: unknown[] = []
  closedWith: number | null = null
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: { code: number }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close(code = 1000) {
    this.closedWith = code
    this.readyState = 3
    this.onclose?.({ code })
  }
  // test helpers
  open() {
    this.readyState = 1
    this.onopen?.({})
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
  drop(code = 1006) {
    this.readyState = 3
    this.onclose?.({ code })
  }
}

function setup(over: Partial<StreamOptions> = {}) {
  const sockets: FakeSocket[] = []
  const timers: { fn: () => void; ms: number; id: number; cleared: boolean }[] = []
  let next = 1
  const opts: StreamOptions = {
    serverUrl: 'https://ai.example.com',
    token: 'anemo_t',
    lastId: '5-0',
    version: '1',
    onEvent: vi.fn(),
    onWelcome: vi.fn(),
    onState: vi.fn(),
    presence: async () => ({ active: true, discord_skip: true }),
    ...over,
  }
  const stream = new EventStream(opts, {
    connect: (url) => {
      const s = new FakeSocket(url)
      sockets.push(s)
      return s
    },
    setTimeout: (fn, ms) => {
      const t = { fn, ms, id: next++, cleared: false }
      timers.push(t)
      return t.id
    },
    clearTimeout: (id) => {
      const t = timers.find((x) => x.id === id)
      if (t) t.cleared = true
    },
    random: () => 1,
  })
  const run = (ms: number) => {
    for (const t of timers.filter((x) => !x.cleared && x.ms === ms)) {
      t.cleared = true
      t.fn()
    }
  }
  return { stream, sockets, timers, opts, run }
}

describe('EventStream', () => {
  it('says hello with the token and last id, then relays events', async () => {
    const { stream, sockets, opts } = setup()
    stream.start()
    expect(sockets[0].url).toBe('wss://ai.example.com/api/extension/ws')
    sockets[0].open()
    expect(sockets[0].sent[0]).toEqual({ type: 'hello', token: 'anemo_t', last_id: '5-0', version: '1' })
    sockets[0].receive({ type: 'welcome', missed: false })
    expect(opts.onWelcome).toHaveBeenCalledWith(false, null)
    expect(opts.onState).toHaveBeenCalledWith('connected')
    await Promise.resolve()
    expect(sockets[0].sent).toContainEqual({ type: 'presence', active: true, discord_skip: true })
    sockets[0].receive({ type: 'event', id: '6-0', event: 'notification', data: { title: 'x' } })
    expect(opts.onEvent).toHaveBeenCalledWith({ id: '6-0', event: 'notification', data: { title: 'x' } })
  })

  it('reconnects with backoff and resumes after the last event', () => {
    const { stream, sockets, run } = setup()
    stream.start()
    sockets[0].open()
    sockets[0].receive({ type: 'welcome', missed: false })
    sockets[0].receive({ type: 'event', id: '9-0', event: 'run.status', data: {} })
    sockets[0].drop()
    run(1000) // first retry after 1 s
    expect(sockets).toHaveLength(2)
    sockets[1].open()
    expect(sockets[1].sent[0]).toMatchObject({ type: 'hello', last_id: '9-0' })
  })

  it('resumes from the welcome cursor when no event came before a drop', () => {
    const { stream, sockets, run } = setup({ lastId: null })
    stream.start()
    sockets[0].open()
    sockets[0].receive({ type: 'welcome', missed: false, cursor: '42-0' })
    sockets[0].drop()
    run(1000)
    sockets[1].open()
    expect(sockets[1].sent[0]).toMatchObject({ type: 'hello', last_id: '42-0' })
  })

  it('backs off 1 s, 2 s, 4 s … up to 60 s', () => {
    expect([1, 2, 3, 4, 7, 20].map((n) => backoff(n, () => 1))).toEqual([1000, 2000, 4000, 8000, 60000, 60000])
    expect(backoff(1, () => 0)).toBe(500)
  })

  it('stops for good on a revoked token or a refusal', () => {
    const a = setup()
    a.stream.start()
    a.sockets[0].open()
    a.sockets[0].drop(CLOSE_UNAUTHORIZED)
    expect(a.opts.onState).toHaveBeenLastCalledWith('unauthorized')
    expect(a.timers.filter((t) => !t.cleared && t.ms === 1000)).toHaveLength(0)
    const b = setup()
    b.stream.start()
    b.sockets[0].open()
    b.sockets[0].drop(CLOSE_REFUSED)
    expect(b.opts.onState).toHaveBeenLastCalledWith('refused')
  })

  it('pings every 20 s and drops a silent connection', () => {
    const { stream, sockets, run } = setup()
    stream.start()
    sockets[0].open()
    sockets[0].receive({ type: 'welcome', missed: false })
    run(PING_MS)
    expect(sockets[0].sent).toContainEqual({ type: 'ping' })
    run(SILENCE_MS)
    expect(sockets[0].closedWith).toBe(4000)
  })

  it('stop() closes and never reconnects', () => {
    const { stream, sockets, timers } = setup()
    stream.start()
    sockets[0].open()
    stream.stop()
    expect(sockets[0].closedWith).toBe(1000)
    expect(timers.filter((t) => !t.cleared && t.ms === 1000)).toHaveLength(0)
  })

  it('uses ws:// for a plain-http server on the local network', () => {
    expect(wsUrl('http://192.168.1.5:8080')).toBe('ws://192.168.1.5:8080/api/extension/ws')
  })
})
