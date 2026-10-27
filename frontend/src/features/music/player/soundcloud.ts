import { loadScript, playerHost } from './host'
import type { Adapter, AdapterEvents, Track } from './types'

interface SCSound {
  title?: string
  user?: { username?: string }
  artwork_url?: string | null
}

interface SCWidget {
  bind(event: string, cb: (e?: { currentPosition?: number }) => void): void
  load(url: string, opts: Record<string, unknown> & { callback?: () => void }): void
  play(): void
  pause(): void
  next(): void
  prev(): void
  seekTo(ms: number): void
  setVolume(v: number): void
  getDuration(cb: (ms: number) => void): void
  getCurrentSound(cb: (s: SCSound | null) => void): void
  getCurrentSoundIndex(cb: (i: number) => void): void
  getSounds(cb: (s: SCSound[]) => void): void
}

interface SCNamespace {
  Widget: ((iframe: HTMLIFrameElement) => SCWidget) & { Events: Record<string, string> }
}

declare global {
  interface Window {
    SC?: SCNamespace
  }
}

function widgetSrc(url: string, autoplay: boolean): string {
  const params = new URLSearchParams({
    url,
    auto_play: String(autoplay),
    visual: 'false',
    show_artwork: 'true',
    buying: 'false',
    sharing: 'false',
    download: 'false',
  })
  return `https://w.soundcloud.com/player/?${params}`
}

/** SoundCloud tracks and sets, through SoundCloud's Widget API. */
export class SoundCloudAdapter implements Adapter {
  private widget: SCWidget | null = null
  private position = 0
  private duration = 0
  private index = 0
  private count = 1
  private volume = 0.7
  private pendingPlay = false
  private startAt = 0
  private mounting = false
  private queued: { track: Track; autoplay: boolean; startAt: number } | null = null

  private events: AdapterEvents

  constructor(events: AdapterEvents) {
    this.events = events}

  private refreshMeta() {
    const w = this.widget
    if (!w) return
    w.getDuration((ms) => (this.duration = ms / 1000))
    w.getCurrentSoundIndex((i) => (this.index = i ?? 0))
    w.getSounds((s) => (this.count = Math.max(1, s?.length ?? 1)))
    w.getCurrentSound((s) => {
      if (!s) return
      this.events.onMeta({
        title: s.title ?? undefined,
        artist: s.user?.username ?? undefined,
        artwork: s.artwork_url ? s.artwork_url.replace('-large', '-t500x500') : undefined,
      })
    })
  }

  private seekToStart() {
    if (this.startAt > 0) this.widget?.seekTo(this.startAt * 1000)
    this.startAt = 0
  }

  load(track: Track, autoplay: boolean, startAt = 0) {
    this.position = 0
    this.duration = 0
    this.startAt = startAt
    this.events.onState('buffering')
    if (this.widget) {
      this.widget.load(track.url, {
        auto_play: autoplay,
        visual: false,
        callback: () => {
          this.widget?.setVolume(this.volume * 100)
          this.refreshMeta()
          this.seekToStart()
          if (!autoplay) this.events.onState('paused')
        },
      })
      return
    }
    this.pendingPlay = autoplay
    if (this.mounting) {
      this.queued = { track, autoplay, startAt }
      return
    }
    this.mounting = true
    loadScript('https://w.soundcloud.com/player/api.js')
      .then(() => {
        const SC = window.SC!
        const iframe = document.createElement('iframe')
        iframe.allow = 'autoplay; encrypted-media'
        iframe.width = '200'
        iframe.height = '200'
        iframe.title = 'SoundCloud player'
        iframe.src = widgetSrc(track.url, autoplay)
        playerHost().appendChild(iframe)
        const w = SC.Widget(iframe)
        const E = SC.Widget.Events
        w.bind(E.READY, () => {
          if (this.widget) return
          this.widget = w
          this.mounting = false
          w.setVolume(this.volume * 100)
          if (this.queued) {
            const q = this.queued
            this.queued = null
            this.load(q.track, q.autoplay, q.startAt)
            return
          }
          this.refreshMeta()
          this.seekToStart()
          if (this.pendingPlay) w.play()
          else this.events.onState('paused')
        })
        w.bind(E.PLAY, () => {
          this.events.onState('playing')
          this.refreshMeta()
        })
        w.bind(E.PAUSE, () => this.events.onState('paused'))
        w.bind(E.PLAY_PROGRESS, (e) => {
          if (e?.currentPosition != null) this.position = e.currentPosition / 1000
        })
        w.bind(E.FINISH, () => {
          // Inside a set the widget moves on by itself; only the end of the last sound counts.
          if (this.index >= this.count - 1) this.events.onState('ended')
        })
        w.bind(E.ERROR, () => this.events.onError('SoundCloud could not play this link.'))
      })
      .catch(() => {
        this.mounting = false
        this.events.onError('SoundCloud could not be reached.')
      })
  }

  play() {
    if (this.widget) this.widget.play()
    else this.pendingPlay = true
  }

  pause() {
    if (this.widget) this.widget.pause()
    else this.pendingPlay = false
  }

  stop() {
    this.widget?.pause()
  }

  seek(seconds: number) {
    this.widget?.seekTo(seconds * 1000)
    this.position = seconds
  }

  setVolume(v: number) {
    this.volume = v
    this.widget?.setVolume(Math.round(v * 100))
  }

  getPosition() {
    return this.position
  }

  getDuration() {
    return this.duration
  }

  next() {
    if (this.widget && this.index < this.count - 1) {
      this.widget.next()
      return true
    }
    return false
  }

  prev() {
    if (this.widget && this.index > 0) {
      this.widget.prev()
      return true
    }
    return false
  }
}
