import { beforeEach, describe, expect, it, vi } from 'vitest'

/* What the agent's music control does with the queue: append, or replace with `replace`. */
const calls = vi.hoisted(() => ({ player: [] as string[], alerts: [] as string[] }))

vi.mock('./tab', () => ({ tabId: () => 'this-tab' }))
vi.mock('@/features/island/alerts', () => ({ islandAlert: (a: { title: string }) => calls.alerts.push(a.title) }))
vi.mock('@/features/focus/timerStore', () => ({ timerActions: { focusOn: () => {} } }))
vi.mock('@/features/music/player/controller', () => ({
  fromLibrary: (t: { ref: string }) => ({ ref: t.ref }),
  buildTracks: async (url: string) => {
    if (url === 'bad') throw new Error('Paste a YouTube, SoundCloud or audio link.')
    return [{ ref: `from ${url}` }]
  },
  player: {
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
