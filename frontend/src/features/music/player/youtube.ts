import { playerHost } from './host'
import type { Adapter, AdapterEvents, Track } from './types'

/* The part of the YouTube IFrame API used here. */
export interface YTPlayer {
  mute(): void
  loadVideoById(id: string | { videoId: string; startSeconds?: number }): void
  cueVideoById(id: string | { videoId: string; startSeconds?: number }): void
  cuePlaylist(opts: { listType: 'playlist'; list: string }): void
  getPlaylist(): string[] | null
  playVideo(): void
  pauseVideo(): void
  stopVideo(): void
  seekTo(s: number, allowSeekAhead: boolean): void
  setVolume(v: number): void
  getCurrentTime(): number
  getDuration(): number
  getVideoData(): { title?: string; author?: string; video_id?: string; isLive?: boolean }
  destroy(): void
}

interface YTNamespace {
  Player: new (
    el: HTMLElement,
    opts: {
      width?: string | number
      height?: string | number
      host?: string
      videoId?: string
      playerVars?: Record<string, string | number>
      events?: {
        onReady?: (e: { target: YTPlayer }) => void
        onStateChange?: (e: { data: number; target: YTPlayer }) => void
        onError?: (e: { data: number }) => void
      }
    },
  ) => YTPlayer
}

declare global {
  interface Window {
    YT?: YTNamespace
    onYouTubeIframeAPIReady?: () => void
  }
}

let apiPromise: Promise<YTNamespace> | null = null

export function loadApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT)
  if (!apiPromise) {
    apiPromise = new Promise((resolve, reject) => {
      const prev = window.onYouTubeIframeAPIReady
      window.onYouTubeIframeAPIReady = () => {
        prev?.()
        resolve(window.YT!)
      }
      const s = document.createElement('script')
      s.src = 'https://www.youtube.com/iframe_api'
      s.async = true
      s.onerror = () => {
        apiPromise = null
        reject(new Error('YouTube could not be reached.'))
      }
      document.head.appendChild(s)
    })
  }
  return apiPromise
}

/**
 * YouTube wants embeds to say which site they are on (the Referer header) and refuses
 * to play (errors 101/150/152/153) without it. Building the iframe here fixes its
 * referrer policy before the first request, whatever the page or a proxy sets.
 */
export const HOSTS = ['https://www.youtube.com', 'https://www.youtube-nocookie.com']

export function mountIframe(host: string, extra: Record<string, string> = {}): HTMLIFrameElement {
  const iframe = document.createElement('iframe')
  iframe.referrerPolicy = 'strict-origin-when-cross-origin'
  iframe.allow = 'autoplay; encrypted-media; picture-in-picture'
  iframe.width = '200'
  iframe.height = '200'
  iframe.title = 'YouTube player'
  const params = new URLSearchParams({
    enablejsapi: '1',
    playsinline: '1',
    controls: '0',
    disablekb: '1',
    rel: '0',
    origin: window.location.origin,
    widget_referrer: window.location.origin,
    ...extra,
  })
  iframe.src = `${host}/embed/?${params}`
  playerHost().appendChild(iframe)
  return iframe
}

/** Codes YouTube uses when it refuses to play inside an embed. */
export const EMBED_REFUSED = new Set([101, 150, 152, 153])

const ERRORS: Record<number, string> = {
  2: 'That YouTube link looks wrong.',
  5: 'YouTube could not play this video here.',
  100: 'This YouTube video was removed or is private.',
  101: 'The owner does not allow this video to play outside YouTube.',
  150: 'The owner does not allow this video to play outside YouTube.',
  152: 'YouTube refused to play this video here.',
  153: "YouTube refused to play because it couldn't tell which site it's on. Check that your proxy keeps the Referer header.",
}

export class YouTubeAdapter implements Adapter {
  private player: YTPlayer | null = null
  private ready: Promise<YTPlayer> | null = null
  private volume = 0.7
  /** Index into HOSTS; switches when YouTube refuses an embed on one domain. */
  private host = 0
  private current: { track: Track; autoplay: boolean; startAt: number; retried: boolean } | null = null

  private events: AdapterEvents

  constructor(events: AdapterEvents) {
    this.events = events}

  private ensure(): Promise<YTPlayer> {
    if (!this.ready) {
      this.ready = loadApi().then(
        (YT) =>
          new Promise<YTPlayer>((resolve) => {
            new YT.Player(mountIframe(HOSTS[this.host]), {
              events: {
                onReady: (e) => {
                  this.player = e.target
                  e.target.setVolume(this.volume * 100)
                  resolve(e.target)
                },
                onStateChange: (e) => this.handleState(e.data),
                onError: (e) => this.handleError(e.data),
              },
            })
          }),
      )
      this.ready.catch((err: Error) => {
        this.ready = null
        this.events.onError(err.message)
      })
    }
    return this.ready
  }

  /** Throw the player away, so the next load builds a fresh one (on the current host). */
  private reset() {
    const old = this.player
    this.player = null
    this.ready = null
    try {
      const iframe = (old as unknown as { getIframe?: () => HTMLIFrameElement })?.getIframe?.()
      old?.destroy()
      iframe?.remove()
    } catch {
      // already gone
    }
  }

  private start(p: YTPlayer, c: { track: Track; autoplay: boolean; startAt: number }) {
    const video = { videoId: c.track.ref, startSeconds: c.startAt > 0 ? c.startAt : undefined }
    if (c.autoplay) p.loadVideoById(video)
    else p.cueVideoById(video)
  }

  private handleError(code: number) {
    const cur = this.current
    // A refusal is often about the domain or referrer, not the video: try the other YouTube host once.
    if (EMBED_REFUSED.has(code) && cur && !cur.retried) {
      cur.retried = true
      this.host = (this.host + 1) % HOSTS.length
      this.reset()
      this.events.onState('buffering')
      void this.ensure().then((p) => this.start(p, cur))
      return
    }
    const refused = EMBED_REFUSED.has(code)
    this.events.onError(`${ERRORS[code] ?? 'YouTube could not play this.'}${refused ? ` (code ${code})` : ''}`, refused ? 'blocked' : undefined)
  }

  private handleState(code: number) {
    // -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
    if (code === 1) {
      this.events.onState('playing')
      const data = this.player?.getVideoData()
      if (data?.title) this.events.onMeta({ title: data.title, artist: data.author ?? '', live: !!data.isLive })
    } else if (code === 2 || code === 5) this.events.onState('paused')
    else if (code === 3) this.events.onState('buffering')
    else if (code === 0) this.events.onState('ended')
  }

  load(track: Track, autoplay: boolean, startAt = 0) {
    this.current = { track, autoplay, startAt, retried: false }
    const cur = this.current
    if (this.player) {
      this.start(this.player, cur)
      return
    }
    this.events.onState('buffering')
    void this.ensure().then((p) => this.start(p, cur))
  }

  play() {
    this.player?.playVideo()
  }

  pause() {
    this.player?.pauseVideo()
  }

  stop() {
    this.player?.stopVideo()
  }

  seek(seconds: number) {
    this.player?.seekTo(seconds, true)
  }

  setVolume(v: number) {
    this.volume = v
    this.player?.setVolume(Math.round(v * 100))
  }

  getPosition() {
    return this.player?.getCurrentTime() ?? 0
  }

  getDuration() {
    return this.player?.getDuration() ?? 0
  }
}

/** The video ids of a YouTube playlist, read with a throwaway player. */
export async function expandYouTubePlaylist(listId: string): Promise<string[]> {
  const YT = await loadApi()
  return new Promise((resolve, reject) => {
    const el = mountIframe(HOSTS[0], { listType: 'playlist', list: listId })
    let player: YTPlayer | null = null
    const cleanup = () => {
      try {
        player?.destroy()
      } catch {
        // already gone
      }
      el.remove()
    }
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('The YouTube playlist took too long to load.'))
    }, 15_000)
    new YT.Player(el, {
      events: {
        onReady: (e) => {
          player = e.target
          e.target.cuePlaylist({ listType: 'playlist', list: listId })
        },
        onStateChange: (e) => {
          if (e.data !== 5) return
          const ids = e.target.getPlaylist()
          if (ids?.length) {
            clearTimeout(timeout)
            cleanup()
            resolve(ids)
          }
        },
        onError: () => {
          clearTimeout(timeout)
          cleanup()
          reject(new Error('That YouTube playlist is private or unavailable.'))
        },
      },
    })
  })
}
