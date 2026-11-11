import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdapterEvents, Track } from './types'

/* Two stand-in players that record what they were asked to do: YouTube's own, and the audio element. */
const fake = vi.hoisted(() => ({
  youtube: null as AdapterEvents | null,
  audio: null as AdapterEvents | null,
  calls: [] as string[],
  prepared: [] as string[],
  toasts: [] as string[],
}))

function adapter(name: 'youtube' | 'audio') {
  return class {
    constructor(events: AdapterEvents) {
      fake[name] = events
    }
    load(track: Track, autoplay: boolean, startAt = 0) {
      fake.calls.push(`${name} load ${track.url} ${autoplay ? 'play' : 'cue'}${startAt ? ` @${startAt}` : ''}`)
    }
    play() {
      fake.calls.push(`${name} play`)
    }
    pause() {
      fake.calls.push(`${name} pause`)
    }
    stop() {
      fake.calls.push(`${name} stop`)
    }
    seek() {}
    setVolume() {}
    getPosition() {
      return 0
    }
    getDuration() {
      return 200
    }
  }
}

vi.mock('./youtube', () => ({ YouTubeAdapter: adapter('youtube'), expandYouTubePlaylist: async () => [] }))
vi.mock('./audio', () => ({ AudioAdapter: adapter('audio') }))
vi.mock('@/components/ui/toast', () => ({ toast: (t: { message: string }) => fake.toasts.push(t.message) }))
vi.mock('@/api/client', () => ({
  api: {
    // What the server answers when asked why: it was refused.
    GET: async () => ({ error: { message: 'YouTube refused the request from Anemo’s server.' }, response: { body: null } }),
    POST: async (_path: string, options: { params: { path: { video_id: string } } }) => {
      fake.prepared.push(options.params.path.video_id)
      return { data: undefined }
    },
  },
  unwrap: (answer: { error?: { message: string } }) => {
    if (answer.error) throw new Error(answer.error.message)
  },
  errorMessage: (err: Error) => err.message,
}))

const { player, setPlayerPrefs, usePlayerStore, usePlayerRuntime, viaServer, MAX_SERVER_FAILURES } = await import('./controller')
const { useIslandAlerts, dismissIslandAlert } = await import('@/features/island/alerts')

const yt = (ref: string, extra: Partial<Track> = {}): Track =>
  ({ id: `id-${ref}`, source: 'youtube', ref, url: `https://www.youtube.com/watch?v=${ref}`, title: ref, artist: '', artwork: null, ...extra })
const served = (ref: string) => `/api/music/audio/youtube/${ref}`

function queue(...tracks: Track[]) {
  usePlayerStore.setState({ queue: tracks, index: 0, shuffle: false, repeat: 'off', position: 0 })
  usePlayerRuntime.setState({ status: 'unstarted', loaded: false, error: null, blocked: false })
}

describe('YouTube through the server', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    fake.calls = []
    fake.prepared = []
    fake.toasts = []
    setPlayerPrefs({ trackAlerts: false, serverAudio: true })
  })
  afterEach(() => {
    player.pause()
    vi.advanceTimersByTime(120_000)
    while (useIslandAlerts.getState().current) dismissIslandAlert()
    vi.useRealTimers()
  })

  it('plays a YouTube track in the audio element, from the server’s address', () => {
    queue(yt('aaaaaaaaaaa'), yt('bbbbbbbbbbb'))
    player.playIndex(0)
    expect(fake.calls).toEqual([`audio load ${served('aaaaaaaaaaa')} play`])
    // Pause and play go to that player too, and the queue keeps the YouTube link.
    fake.audio!.onState('playing')
    player.pause()
    player.play()
    expect(fake.calls.slice(1)).toEqual(['audio pause', 'audio play'])
    expect(usePlayerStore.getState().queue[0].url).toBe('https://www.youtube.com/watch?v=aaaaaaaaaaa')
  })

  it('has the server look up the next track while this one plays', () => {
    queue(yt('ccccccccccc'), yt('ddddddddddd'))
    player.playIndex(0)
    expect(fake.prepared).toEqual([])
    fake.audio!.onState('playing')
    fake.audio!.onState('playing') // once per track, not on every report
    expect(fake.prepared).toEqual(['ddddddddddd'])
  })

  it('leaves live streams, other sources and everything when switched off to their own players', () => {
    expect(viaServer(yt('eeeeeeeeeee'))).toBe(true)
    expect(viaServer(yt('eeeeeeeeeee', { live: true }))).toBe(false)
    expect(viaServer({ source: 'soundcloud', ref: 'https://soundcloud.com/a/b' })).toBe(false)
    expect(viaServer({ source: 'audio', ref: 'https://example.com/a.mp3' })).toBe(false)

    setPlayerPrefs({ trackAlerts: false, serverAudio: false })
    queue(yt('eeeeeeeeeee'))
    player.playIndex(0)
    expect(fake.calls).toEqual(['audio stop', 'youtube load https://www.youtube.com/watch?v=eeeeeeeeeee play'])
  })

  it('falls back to YouTube’s own player when the server cannot fetch a track, and says why once', async () => {
    queue(yt('fffffffffff'), yt('ggggggggggg'))
    player.playIndex(0)
    fake.calls = []
    fake.audio!.onError('This link is not a playable audio file or stream.')
    // The same track, still wanted, through the other player: nothing is skipped.
    expect(fake.calls).toEqual(['audio stop', 'youtube load https://www.youtube.com/watch?v=fffffffffff play'])
    expect(usePlayerStore.getState().index).toBe(0)
    expect(usePlayerRuntime.getState().error).toBeNull()
    await vi.advanceTimersByTimeAsync(10)
    expect(fake.toasts).toHaveLength(1)
    expect(fake.toasts[0]).toContain('YouTube refused the request')

    // That track stays with YouTube's player for the session; the next one tries the server again.
    expect(viaServer(yt('fffffffffff'))).toBe(false)
    fake.calls = []
    player.next()
    expect(fake.calls).toEqual(['youtube stop', `audio load ${served('ggggggggggg')} play`])
  })

  it('stops asking the server after several tracks in a row could not be fetched', async () => {
    const refs = Array.from({ length: MAX_SERVER_FAILURES + 1 }, (_, i) => `h${String(i).padStart(10, '0')}`)
    queue(...refs.map((ref) => yt(ref)))
    player.playIndex(0)
    for (let i = 0; i < MAX_SERVER_FAILURES; i++) {
      // Each of them fails at the server, plays through YouTube's player, and the queue moves on.
      fake.audio!.onError('x')
      fake.youtube!.onState('playing')
      fake.calls = []
      player.next()
    }
    // The one after that does not try the server any more.
    expect(fake.calls).toEqual([`youtube load https://www.youtube.com/watch?v=${refs[MAX_SERVER_FAILURES]} play`])
    await vi.advanceTimersByTimeAsync(10)
    expect(fake.toasts.length).toBeLessThanOrEqual(1) // said once in a session
  })
})
