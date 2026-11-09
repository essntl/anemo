import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => [] as string[])

vi.mock('./player/controller', async () => {
  const { create } = await import('zustand')
  const usePlayerStore = create(() => ({ queue: [{ id: 'q1', title: 'Song', artist: 'Band', url: 'https://youtu.be/a' }], index: 0 }))
  const usePlayerRuntime = create(() => ({ status: 'paused', adding: false, error: null as string | null }))
  return {
    usePlayerStore,
    usePlayerRuntime,
    player: {
      toggle: () => calls.push('toggle'),
      play: () => calls.push('play'),
      pause: () => calls.push('pause'),
      next: () => calls.push('next'),
      prev: () => calls.push('prev'),
      add: async (url: string) => {
        calls.push(`add ${url}`)
        if (url.includes('bad')) throw new Error('Not a link Anemo can play.')
        return [{}, {}]
      },
      clear: () => calls.push('clear'),
      playTracks: () => calls.push('playTracks'),
    },
  }
})

const { startExtensionBridge } = await import('./extensionBridge')

/** The page's answers to the extension. */
function answers(): Record<string, unknown>[] {
  return posted.filter((m) => m.source === 'anemo-player')
}
let posted: Record<string, unknown>[] = []
let stop: () => void

function fromExtension(command: Record<string, unknown>, source: MessageEventSource | null = window) {
  window.dispatchEvent(new MessageEvent('message', { data: { source: 'anemo-companion', command }, origin: window.location.origin, source }))
}

beforeEach(() => {
  calls.length = 0
  posted = []
  vi.spyOn(window, 'postMessage').mockImplementation(((m: Record<string, unknown>) => void posted.push(m)) as typeof window.postMessage)
  stop = startExtensionBridge()
})
afterEach(() => {
  stop()
  vi.restoreAllMocks()
})

describe('the extension bridge', () => {
  it('answers hello with what is playing', async () => {
    fromExtension({ type: 'hello' })
    await vi.waitFor(() => expect(answers()).toHaveLength(1))
    expect(answers()[0]).toEqual({
      source: 'anemo-player',
      type: 'state',
      state: { status: 'paused', title: 'Song', artist: 'Band', url: 'https://youtu.be/a', index: 0, queueLength: 1, adding: false, error: null },
    })
  })

  it('plays, pauses and skips; adds a link to the end, and says how it went', async () => {
    for (const type of ['toggle', 'play', 'pause', 'next', 'prev']) fromExtension({ type })
    fromExtension({ type: 'add', url: 'https://youtu.be/b', id: 'r1' })
    fromExtension({ type: 'add', url: 'https://bad.example/x', id: 'r2' })
    fromExtension({ type: 'add', url: 'javascript:alert(1)', id: 'r3' })
    await vi.waitFor(() => expect(answers().filter((a) => a.type === 'added')).toHaveLength(3))
    expect(calls).toEqual(['toggle', 'play', 'pause', 'next', 'prev', 'add https://youtu.be/b', 'add https://bad.example/x'])
    const added = Object.fromEntries(answers().filter((a) => a.type === 'added').map((a) => [a.id, a]))
    expect(added.r1).toMatchObject({ ok: true, count: 2 })
    expect(added.r2).toMatchObject({ ok: false, error: 'Not a link Anemo can play.' })
    expect(added.r3).toMatchObject({ ok: false })
  })

  it('takes nothing from other windows, and nothing that would clear the queue', async () => {
    const frame = document.createElement('iframe')
    document.body.append(frame)
    fromExtension({ type: 'next' }, frame.contentWindow)
    fromExtension({ type: 'clear' })
    fromExtension({ type: 'playTracks' })
    window.dispatchEvent(new MessageEvent('message', { data: { source: 'someone-else', command: { type: 'next' } }, origin: window.location.origin, source: window }))
    await new Promise((r) => setTimeout(r, 20))
    expect(calls).toEqual([])
  })
})
