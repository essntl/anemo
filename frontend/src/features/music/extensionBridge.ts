/**
 * The browser extension's remote for this tab's music player (Anemo Companion: play,
 * pause, skip, add a link). The extension's script in this tab posts commands to the
 * page and gets back what is playing.
 *
 * Only messages from this window itself are taken: the extension's script runs in it,
 * while embedded players (YouTube, SoundCloud) and anything else are other windows. The
 * remote can add to the end of the queue, but never replace or clear it.
 */
import { player, usePlayerRuntime, usePlayerStore } from './player/controller'

export const FROM_EXTENSION = 'anemo-companion'
export const TO_EXTENSION = 'anemo-player'

export type BridgeCommand =
  | { type: 'hello' }
  | { type: 'toggle' }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'add'; url: string; id: string }

/** What the extension shows: the track, whether it plays, and the queue's size. */
export interface NowPlaying {
  status: string
  title: string | null
  artist: string | null
  url: string | null
  index: number
  queueLength: number
  adding: boolean
  error: string | null
}

export function nowPlaying(): NowPlaying {
  const { queue, index } = usePlayerStore.getState()
  const rt = usePlayerRuntime.getState()
  const track = queue[index] ?? null
  return {
    status: rt.status,
    title: track?.title ?? null,
    artist: track?.artist || null,
    url: track?.url ?? null,
    index,
    queueLength: queue.length,
    adding: rt.adding,
    error: rt.error,
  }
}

function post(message: Record<string, unknown>): void {
  window.postMessage({ source: TO_EXTENSION, ...message }, window.location.origin)
}

function isCommand(data: unknown): data is { source: string; command: BridgeCommand } {
  if (!data || typeof data !== 'object') return false
  const d = data as { source?: unknown; command?: { type?: unknown; url?: unknown; id?: unknown } }
  if (d.source !== FROM_EXTENSION || !d.command || typeof d.command.type !== 'string') return false
  if (d.command.type === 'add') return typeof d.command.url === 'string' && d.command.url.length <= 2000 && typeof d.command.id === 'string'
  return ['hello', 'toggle', 'play', 'pause', 'next', 'prev'].includes(d.command.type)
}

async function run(command: BridgeCommand): Promise<void> {
  switch (command.type) {
    case 'hello':
      break
    case 'toggle':
      player.toggle()
      break
    case 'play':
      player.play()
      break
    case 'pause':
      player.pause()
      break
    case 'next':
      player.next()
      break
    case 'prev':
      player.prev()
      break
    case 'add':
      if (!/^https?:\/\//i.test(command.url)) {
        post({ type: 'added', id: command.id, ok: false, error: 'The link must start with https:// or http://.' })
        return
      }
      try {
        const tracks = await player.add(command.url)
        post({ type: 'added', id: command.id, ok: true, count: tracks.length })
      } catch (err) {
        post({ type: 'added', id: command.id, ok: false, error: err instanceof Error ? err.message : "Couldn't add that link." })
      }
      break
  }
}

/** Listen for the extension's commands and report changes; returns a stop function. */
export function startExtensionBridge(): () => void {
  let last = ''
  const report = () => {
    const state = nowPlaying()
    const key = JSON.stringify(state)
    if (key === last) return
    last = key
    post({ type: 'state', state })
  }
  const onMessage = (e: MessageEvent) => {
    if (e.source !== window || e.origin !== window.location.origin || !isCommand(e.data)) return
    void run(e.data.command).then(() => {
      if (e.data.command.type === 'hello') last = '' // asked: answer even if nothing changed
      report()
    })
  }
  window.addEventListener('message', onMessage)
  const offStore = usePlayerStore.subscribe(report)
  const offRuntime = usePlayerRuntime.subscribe(report)
  return () => {
    window.removeEventListener('message', onMessage)
    offStore()
    offRuntime()
  }
}
