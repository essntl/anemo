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

const { player, setPlayerPrefs, usePlayerStore, usePlayerRuntime, nextIndex, upNext, MAX_SKIPS } = await import('./controller')
const { useIslandAlerts, dismissIslandAlert } = await import('@/features/island/alerts')

function track(ref: string): Track {
  return { id: `id-${ref}`, source: 'youtube', ref, url: `https://www.youtube.com/watch?v=${ref}`, title: ref, artist: '', artwork: null }
}

describe('music controller', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // These are about the queue and YouTube's own player (the server's audio: serverAudio.test.ts).
    setPlayerPrefs({ trackAlerts: true, serverAudio: false })
    fake.calls = []
    usePlayerStore.setState({ queue: ['a', 'b', 'c', 'd'].map(track), index: 0, shuffle: false, repeat: 'all', position: 0 })
    usePlayerRuntime.setState({ status: 'unstarted', loaded: false, error: null, blocked: false })
  })
  afterEach(() => {
    // Nothing is left waiting to start the music again in the next test.
    player.pause()
    vi.advanceTimersByTime(120_000)
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

  /** The page goes out of sight (a phone switching apps) or comes back. */
  function show(visible: boolean) {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (visible ? 'visible' : 'hidden') })
    document.dispatchEvent(new Event('visibilitychange'))
  }

  it('undoes the pause that comes with the page going out of sight', () => {
    player.playIndex(0)
    fake.events!.onState('playing')
    vi.advanceTimersByTime(10_000)
    fake.calls = []
    try {
      show(false)
      fake.events!.onState('paused') // the phone's browser stopped it
      vi.advanceTimersByTime(400)
      expect(fake.calls).toContain('play')
      // Stopped again right after the try: it keeps trying, patiently.
      fake.calls = []
      fake.events!.onState('playing')
      fake.events!.onState('paused')
      vi.advanceTimersByTime(1200)
      expect(fake.calls).toContain('play')
    } finally {
      show(true)
    }

    fake.calls = []
    player.pause() // the user's own pause stays
    fake.events!.onState('paused')
    vi.advanceTimersByTime(60_000)
    expect(fake.calls).toEqual(['pause'])
  })

  it('leaves a pause from outside the app alone (a media key, the phone’s notification)', () => {
    player.playIndex(0)
    fake.events!.onState('playing')
    vi.advanceTimersByTime(10_000)
    fake.calls = []
    // The key reaches the embedded player, not this app: it just reports that it stopped.
    fake.events!.onState('paused')
    vi.advanceTimersByTime(60_000)
    expect(fake.calls).toEqual([])
    expect(usePlayerRuntime.getState().status).toBe('paused')

    // Also while the page has been out of sight for a while (music going on in another tab).
    fake.events!.onState('playing') // the play key
    vi.advanceTimersByTime(10_000)
    try {
      show(false)
      vi.advanceTimersByTime(30_000)
      fake.events!.onState('paused')
      vi.advanceTimersByTime(60_000)
      expect(fake.calls).toEqual([])
    } finally {
      show(true)
    }
  })

  it('takes playing again after such a pause as wanted, so an interruption is undone again', () => {
    player.playIndex(0)
    fake.events!.onState('playing')
    vi.advanceTimersByTime(10_000)
    fake.events!.onState('paused') // the pause key
    fake.events!.onState('playing') // the play key
    vi.advanceTimersByTime(10_000)
    fake.calls = []
    try {
      show(false)
      fake.events!.onState('paused')
      vi.advanceTimersByTime(400)
      expect(fake.calls).toContain('play')
    } finally {
      show(true)
    }
  })

  it('still nudges a player that stops while it is only just starting', () => {
    player.playIndex(0)
    fake.events!.onState('playing')
    fake.calls = []
    fake.events!.onState('paused') // within a moment of starting: a hiccup, not a key press
    vi.advanceTimersByTime(400)
    expect(fake.calls).toContain('play')
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

  it('appends to a queue that is playing without changing what plays', () => {
    player.playIndex(1)
    usePlayerRuntime.setState({ loaded: true, status: 'playing' })
    fake.calls = []
    player.append([track('e'), track('b')], { announce: false })
    const { queue, index } = usePlayerStore.getState()
    expect(queue.map((t) => t.ref)).toEqual(['a', 'b', 'c', 'd', 'e', 'b'])
    expect(index).toBe(1) // still on "b"
    expect(fake.calls).toEqual([]) // nothing restarted
    // A track already in the queue is added as a copy with its own id.
    expect(queue[5].id).not.toBe('id-b')
    expect(queue[4].id).toBe('id-e')
  })

  it('removing the track that is still loading goes on to the next one', () => {
    player.playIndex(1)
    usePlayerRuntime.setState({ status: 'buffering', loaded: true })
    fake.calls = []
    player.remove('id-b')
    expect(usePlayerStore.getState().queue.map((t) => t.ref)).toEqual(['a', 'c', 'd'])
    expect(fake.calls).toEqual(['load c play'])
  })

  it('appends and plays the first new track when asked to play now', () => {
    usePlayerRuntime.setState({ loaded: true, status: 'playing' })
    fake.calls = []
    player.append([track('e')], { announce: false, playNow: true })
    expect(usePlayerStore.getState().index).toBe(4)
    expect(fake.calls).toEqual(['load e play'])
  })
})
