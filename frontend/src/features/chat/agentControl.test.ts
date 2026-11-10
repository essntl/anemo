import { beforeEach, describe, expect, it, vi } from 'vitest'

/* What the agent's music control does with the queue: append, or replace with `replace`. */
const calls = vi.hoisted(() => ({
  player: [] as string[],
  alerts: [] as string[],
  posted: [] as { request: string; state: Record<string, unknown> }[],
  store: { queue: [] as Record<string, unknown>[], index: 0, shuffle: false, repeat: 'off' },
  status: 'paused',
  next: null as number | null,
}))

vi.mock('@/api/client', () => ({
  api: { POST: async (_path: string, init: { body: { request: string; state: Record<string, unknown> } }) => { calls.posted.push(init.body) } },
}))

vi.mock('./tab', () => ({ tabId: () => 'this-tab' }))
vi.mock('@/features/island/alerts', () => ({ islandAlert: (a: { title: string }) => calls.alerts.push(a.title) }))
vi.mock('@/features/focus/timerStore', () => ({ timerActions: { focusOn: () => {} } }))
vi.mock('@/features/music/player/controller', () => ({
  fromLibrary: (t: { ref: string }) => ({ ref: t.ref }),
  buildTracks: async (url: string) => {
    if (url === 'bad') throw new Error('Paste a YouTube, SoundCloud or audio link.')
    return [{ ref: `from ${url}` }]
  },
  usePlayerStore: { getState: () => calls.store },
  usePlayerRuntime: { getState: () => ({ status: calls.status }) },
  nextIndex: () => calls.next,
  player: {
    pause: () => calls.player.push('pause'),
    play: () => calls.player.push('play'),
    next: () => calls.player.push('next'),
    remove: (id: string) => calls.player.push(`remove ${id}`),
    append: (tracks: { ref: string }[], opts: { label?: string }) =>
      calls.player.push(`append ${tracks.map((t) => t.ref).join(',')}${opts.label ? ` as ${opts.label}` : ''}`),
    playTracks: (tracks: { ref: string }[]) => calls.player.push(`replace with ${tracks.map((t) => t.ref).join(',')}`),
  },
}))

const { onMusicControl } = await import('./agentControl')

const playlist = { name: 'Focus', tracks: [{ ref: 'a' }, { ref: 'b' }] } as never

describe('the agent queueing music', () => {
  beforeEach(() => {
    calls.player = []
    calls.alerts = []
    calls.posted = []
  })

  it('appends a link or a playlist by default', async () => {
    expect(await onMusicControl({ tab: 'this-tab', action: 'queue', url: 'https://youtu.be/x' })).toBe(true)
    expect(await onMusicControl({ tab: 'this-tab', action: 'queue', playlist })).toBe(true)
    expect(calls.player).toEqual(['append from https://youtu.be/x', 'append a,b as Focus'])
  })

  it('replaces the queue when asked to', async () => {
    await onMusicControl({ tab: 'this-tab', action: 'queue', replace: true, playlist })
    await onMusicControl({ tab: 'this-tab', action: 'queue', replace: true, url: 'https://youtu.be/y' })
    expect(calls.player).toEqual(['replace with a,b', 'replace with from https://youtu.be/y'])
  })

  it('ignores requests for another tab', async () => {
    expect(await onMusicControl({ tab: 'other-tab', action: 'queue', replace: true, playlist })).toBe(false)
    expect(calls.player).toEqual([])
  })

  it('says so when the link cannot be queued', async () => {
    expect(await onMusicControl({ tab: 'this-tab', action: 'queue', url: 'bad' })).toBe(true)
    expect(calls.player).toEqual([])
    expect(calls.alerts).toEqual(["Couldn't queue the music"])
  })
})

const track = (n: number) => ({ id: `t${n}`, title: `Song ${n}`, artist: 'Band', url: `https://music.example/${n}`, artwork: null, source: 'audio', ref: 'r' })

describe('the agent looking at and controlling the player', () => {
  beforeEach(() => {
    calls.player = []
    calls.posted = []
    calls.store = { queue: [track(1), track(2), track(3)], index: 1, shuffle: false, repeat: 'off' }
    calls.status = 'playing'
    calls.next = 2
  })

  it('reports what plays and the whole queue, without changing anything', async () => {
    expect(await onMusicControl({ tab: 'this-tab', action: 'report', request: 'r1' })).toBe(true)
    expect(calls.player).toEqual([])
    expect(calls.posted).toEqual([{
      request: 'r1',
      state: {
        status: 'playing', index: 1, shuffle: false, repeat: 'off', more: 0,
        queue: [1, 2, 3].map((n) => ({ title: `Song ${n}`, artist: 'Band', url: `https://music.example/${n}`, live: false })),
      },
    }])
  })

  it('pauses, resumes and skips', async () => {
    for (const action of ['pause', 'resume', 'skip'] as const) await onMusicControl({ tab: 'this-tab', action, request: action })
    expect(calls.player).toEqual(['pause', 'play', 'next'])
    expect(calls.posted.map((p) => p.state.problem)).toEqual([undefined, undefined, undefined])
  })

  it('does not skip past the end of the queue', async () => {
    calls.next = null
    await onMusicControl({ tab: 'this-tab', action: 'skip', request: 'r2' })
    expect(calls.player).toEqual([])
    expect(calls.posted[0].state.problem).toMatch(/last track/)
  })

  it('removes the track at a position (counted from 1) and says which it was', async () => {
    await onMusicControl({ tab: 'this-tab', action: 'remove', position: 3, request: 'r3' })
    expect(calls.player).toEqual(['remove t3'])
    expect(calls.posted[0].state.removed).toEqual({ title: 'Song 3', artist: 'Band', url: 'https://music.example/3', live: false })
    await onMusicControl({ tab: 'this-tab', action: 'remove', position: 9, request: 'r4' })
    expect(calls.player).toEqual(['remove t3'])
    expect(calls.posted[1].state.problem).toBe('There is no track at position 9; the queue has 3.')
  })

  it('says so when the queue is empty', async () => {
    calls.store = { ...calls.store, queue: [] }
    await onMusicControl({ tab: 'this-tab', action: 'pause', request: 'r5' })
    expect(calls.player).toEqual([])
    expect(calls.posted[0].state.problem).toBe('The music queue is empty.')
  })

  it('leaves requests for another tab, or without an id to answer under, alone', async () => {
    expect(await onMusicControl({ tab: 'other-tab', action: 'pause', request: 'r6' })).toBe(false)
    expect(await onMusicControl({ tab: 'this-tab', action: 'pause' })).toBe(false)
    expect(calls.player).toEqual([])
    expect(calls.posted).toEqual([])
  })
})
