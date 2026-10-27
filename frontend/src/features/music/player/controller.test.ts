import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdapterEvents, Track } from './types'

/* Every source plays through one fake adapter that records what it was asked to do. */
const fake = vi.hoisted(() => ({
  events: null as AdapterEvents | null,
  calls: [] as string[],
}))

vi.mock('./youtube', () => ({
  YouTubeAdapter: class {
    constructor(events: AdapterEvents) {
      fake.events = events
    }
    load(track: Track, autoplay: boolean, startAt = 0) {
      fake.calls.push(`load ${track.ref} ${autoplay ? 'play' : 'cue'}${startAt ? ` @${startAt}` : ''}`)
    }
    play() {
      fake.calls.push('play')
    }
    pause() {
      fake.calls.push('pause')
    }
    stop() {}
    seek() {}
    setVolume() {}
    getPosition() {
      return 0
    }
    getDuration() {
      return 200
    }
  },
  expandYouTubePlaylist: async () => ['aaaaaaaaaaa', 'bbbbbbbbbbb'],
}))
vi.mock('@/api/client', () => ({
  api: { POST: () => Promise.reject(new TypeError('offline')) },
  unwrap: (x: unknown) => x,
}))

const { player, usePlayerStore, usePlayerRuntime, nextIndex, upNext, MAX_SKIPS } = await import('./controller')
const { useIslandAlerts, dismissIslandAlert } = await import('@/features/island/alerts')

function track(ref: string): Track {
  return { id: `id-${ref}`, source: 'youtube', ref, url: `https://www.youtube.com/watch?v=${ref}`, title: ref, artist: '', artwork: null }
}

describe('music controller', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    fake.calls = []
    usePlayerStore.setState({ queue: ['a', 'b', 'c', 'd'].map(track), index: 0, shuffle: false, repeat: 'all', position: 0 })
    usePlayerRuntime.setState({ status: 'unstarted', loaded: false, error: null, blocked: false })
  })
  afterEach(() => {
    while (useIslandAlerts.getState().current) dismissIslandAlert()
    vi.useRealTimers()
  })

  it('moves through the queue following repeat', () => {
    usePlayerStore.setState({ index: 3 })
    expect(nextIndex(1)).toBe(0) // repeat all wraps
    usePlayerStore.setState({ repeat: 'off' })
    expect(nextIndex(1)).toBeNull()
    usePlayerStore.setState({ index: 0 })
    expect(nextIndex(-1)).toBeNull()
    expect(upNext({ ...usePlayerStore.getState(), index: 3 })).toBeNull()
    expect(upNext({ ...usePlayerStore.getState(), index: 1 })?.track.ref).toBe('c')
  })

  it('resumes after a reload where it was, without playing by itself', () => {
    usePlayerStore.setState({ index: 1, position: 42 })
    player.play()
    expect(fake.calls).toEqual(['load b play @42'])
  })

  it('skips tracks that cannot play, then stops after three in a row', () => {
    player.playIndex(0)
    fake.events!.onError('This video was removed.')
    expect(usePlayerStore.getState().index).toBe(1)
    fake.events!.onError('This video was removed.')
    expect(usePlayerStore.getState().index).toBe(2)
    expect(MAX_SKIPS).toBe(3)
    fake.events!.onError('This video was removed.')
    // The third failure in a row: stop and say why.
    expect(usePlayerStore.getState().index).toBe(2)
    expect(usePlayerRuntime.getState().error).toBe('This video was removed.')
    expect(useIslandAlerts.getState().queue.map((a) => a.title).concat(useIslandAlerts.getState().current?.title ?? '')).toContain("Can't play this")
  })

  it('explains repeated YouTube refusals', () => {
    player.playIndex(0)
    fake.events!.onError('refused (code 150)', 'blocked')
    fake.events!.onError('refused (code 150)', 'blocked')
    fake.events!.onError('refused (code 150)', 'blocked')
    expect(usePlayerRuntime.getState().error).toMatch(/blocker/)
    expect(usePlayerRuntime.getState().blocked).toBe(true)
  })

  it('gets a fresh skip budget once something plays', () => {
    player.playIndex(0)
    fake.events!.onError('x')
    fake.events!.onError('x')
    fake.events!.onState('playing')
    fake.events!.onError('x')
    expect(usePlayerStore.getState().index).toBe(3) // skipped again instead of stopping
  })

  it('undoes a pause it did not ask for', () => {
    player.playIndex(0)
    fake.events!.onState('playing')
    fake.calls = []
    fake.events!.onState('paused') // e.g. a phone hid the page
    vi.advanceTimersByTime(400)
    expect(fake.calls).toContain('play')

    fake.calls = []
    player.pause() // the user's own pause stays
    fake.events!.onState('paused')
    vi.advanceTimersByTime(60_000)
    expect(fake.calls).toEqual(['pause'])
  })

  it('reorders, plays next and removes with undo', () => {
    player.playIndex(1) // b is playing
    player.reorder(['id-d', 'id-c', 'id-b', 'id-a'])
    expect(usePlayerStore.getState().index).toBe(2) // still b
    player.playNext(track('e'))
    expect(usePlayerStore.getState().queue.map((t) => t.ref)).toEqual(['d', 'c', 'b', 'e', 'a'])
    player.move('id-a', -1)
    expect(usePlayerStore.getState().queue.map((t) => t.ref)).toEqual(['d', 'c', 'b', 'a', 'e'])
    player.remove('id-d')
    expect(usePlayerStore.getState().queue.map((t) => t.ref)).toEqual(['c', 'b', 'a', 'e'])
    expect(usePlayerStore.getState().index).toBe(1) // still b
  })

  it('adds a playlist link as all its videos, and starts playing when idle', async () => {
    usePlayerStore.setState({ queue: [], index: 0 })
    const added = await player.add('https://www.youtube.com/playlist?list=PL1')
    expect(added.map((t) => t.ref)).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb'])
    expect(fake.calls).toEqual(['load aaaaaaaaaaa play'])
    await expect(player.add('not a link')).rejects.toThrow('Paste a YouTube, SoundCloud or audio link.')
  })

  it('replaces the queue with a playlist, optionally shuffled', () => {
    player.playTracks([track('x'), track('y'), track('z')], { startAt: 2 })
    expect(usePlayerStore.getState().queue.map((t) => t.ref)).toEqual(['x', 'y', 'z'])
    expect(usePlayerStore.getState().index).toBe(2)
    // Copies get their own ids, so the queue reorders independently of the playlist.
    expect(usePlayerStore.getState().queue[0].id).not.toBe('id-x')
  })
})
