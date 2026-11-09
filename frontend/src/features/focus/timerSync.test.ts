import { beforeEach, describe, expect, it, vi } from 'vitest'

/* A fake server: one shared state with a version, refusing changes made on an older one. */
const server = vi.hoisted(() => ({
  state: null as Record<string, unknown> | null,
  version: 0,
  offline: false,
  puts: [] as { base_version: number; status: string }[],
  posts: [] as string[],
  /** Called after a change is stored and before the answer (the server announces first). */
  onStored: null as null | ((out: Record<string, unknown>) => void),
}))

vi.mock('@/api/client', () => {
  class ApiError extends Error {
    readonly status: number
    readonly code: string
    readonly details: unknown
    constructor(status: number, code: string, message: string, details?: unknown) {
      super(message)
      this.status = status
      this.code = code
      this.details = details
    }
  }
  const out = () => ({ state: server.state, version: server.version, updated_by: 'tab', updated_at: null })
  return {
    ApiError,
    unwrap: (x: unknown) => x,
    api: {
      GET: async () => out(),
      POST: async (path: string) => {
        server.posts.push(path)
        return {}
      },
      PUT: async (_path: string, { body }: { body: { state: Record<string, unknown>; base_version: number } }) => {
        await new Promise((r) => setTimeout(r, 0)) // a request takes a moment
        if (server.offline) throw new TypeError('Failed to fetch')
        server.puts.push({ base_version: body.base_version, status: String(body.state.status) })
        if (body.base_version !== server.version) throw new ApiError(409, 'timer_conflict', 'changed elsewhere', { current: out() })
        server.state = body.state
        server.version += 1
        const stored = out()
        server.onStored?.(stored)
        return stored
      },
    },
  }
})

const { useTimerStore, timerActions } = await import('./timerStore')
const sync = await import('./timerSync')
const { initialState, start, DEFAULT_SETTINGS } = await import('./timer')

beforeEach(async () => {
  await sync.settled()
  Object.assign(server, { state: null, version: 0, offline: false, puts: [], posts: [], onStored: null })
  useTimerStore.setState({ timer: initialState(DEFAULT_SETTINGS) })
  sync.useTimerSync.setState({ version: 0, dirty: false })
})

describe('the shared focus timer', () => {
  it('sends each change made here with the version it was made on', async () => {
    timerActions.start()
    await sync.settled()
    timerActions.pause()
    await sync.settled()
    expect(server.puts).toEqual([
      { base_version: 0, status: 'running' },
      { base_version: 1, status: 'paused' },
    ])
    expect(sync.useTimerSync.getState()).toEqual({ version: 2, dirty: false })
  })

  it('the echo of its own change, arriving before the answer, doesn’t undo a newer change', async () => {
    // Pick focus (sent), then start at once (waits): the event for the first arrives first.
    server.onStored = (stored) => sync.receive(stored as unknown as Parameters<typeof sync.receive>[0])
    timerActions.choosePhase('long_break')
    timerActions.start()
    await sync.settled()
    expect(useTimerStore.getState().timer.status).toBe('running')
    expect(server.state?.status).toBe('running')
    expect(sync.useTimerSync.getState()).toEqual({ version: 2, dirty: false })
  })

  it('a change made elsewhere during our own push is taken once the push is answered', async () => {
    server.onStored = (stored) => {
      server.onStored = null
      // Another device changes it right after ours, and its event arrives before our answer.
      const elsewhere = { ...(stored.state as Record<string, unknown>), status: 'paused', started_at: null, paused_at: Date.now() }
      server.state = elsewhere as typeof server.state
      server.version += 1
      sync.receive({ state: elsewhere, version: server.version, updated_by: 'tab', updated_at: null } as unknown as Parameters<typeof sync.receive>[0])
    }
    timerActions.start()
    await sync.settled()
    await Promise.resolve()
    expect(useTimerStore.getState().timer.status).toBe('paused')
    expect(sync.useTimerSync.getState().version).toBe(2)
  })

  it('takes a newer state from elsewhere, without sounds or a session', async () => {
    const elsewhere = sync.toWire(start(initialState(DEFAULT_SETTINGS), Date.now()))
    sync.receive({ state: { ...elsewhere, task_id: null }, version: 4, updated_by: 'extension', updated_at: null })
    expect(useTimerStore.getState().timer.status).toBe('running')
    expect(sync.useTimerSync.getState()).toEqual({ version: 4, dirty: false })
    // An older or its own version again changes nothing.
    sync.receive({ state: { ...elsewhere, status: 'idle' }, version: 4, updated_by: 'tab', updated_at: null })
    expect(useTimerStore.getState().timer.status).toBe('running')
    expect(server.puts).toEqual([])
  })

  it('a change made on an old version loses to the one made elsewhere', async () => {
    server.state = sync.toWire(start(initialState(DEFAULT_SETTINGS), Date.now()))
    server.version = 7
    sync.useTimerSync.setState({ version: 3 })
    timerActions.choosePhase('long_break')
    await sync.settled()
    expect(server.puts).toEqual([{ base_version: 3, status: 'idle' }])
    expect(useTimerStore.getState().timer.phase).toBe('focus')
    expect(useTimerStore.getState().timer.status).toBe('running')
    expect(sync.useTimerSync.getState()).toEqual({ version: 7, dirty: false })
  })

  it('offline, the timer works here and the change is sent when back', async () => {
    server.offline = true
    timerActions.start()
    await sync.settled()
    expect(useTimerStore.getState().timer.status).toBe('running')
    expect(sync.useTimerSync.getState().dirty).toBe(true)
    server.offline = false
    await sync.pullTimer()
    await sync.settled()
    expect(server.version).toBe(1)
    expect(server.state?.status).toBe('running')
    expect(sync.useTimerSync.getState()).toEqual({ version: 1, dirty: false })
  })

  it('a finished phase goes into Notifications only when this change counted', async () => {
    const t = start(initialState(DEFAULT_SETTINGS), Date.now() - 26 * 60_000)
    useTimerStore.setState({ timer: t })
    server.state = sync.toWire(t)
    server.version = 2
    sync.useTimerSync.setState({ version: 2 })
    timerActions.completeIfDue()
    await sync.settled()
    expect(server.posts).toContain('/api/focus/phase-ended')

    // Another device finished it first: no second entry.
    server.posts = []
    const again = start(initialState(DEFAULT_SETTINGS), Date.now() - 26 * 60_000)
    useTimerStore.setState({ timer: again })
    server.version = 9
    timerActions.completeIfDue()
    await sync.settled()
    expect(server.posts).not.toContain('/api/focus/phase-ended')
  })
})
