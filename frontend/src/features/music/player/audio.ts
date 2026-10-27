import type { Adapter, AdapterEvents, Track } from './types'

/** Direct audio files and internet radio streams, through a plain <audio> element. */
export class AudioAdapter implements Adapter {
  private el: HTMLAudioElement
  private startAt = 0

  private events: AdapterEvents

  constructor(events: AdapterEvents) {
    this.events = events
    this.el = new Audio()
    this.el.preload = 'none'
    this.el.addEventListener('playing', () => this.events.onState('playing'))
    this.el.addEventListener('pause', () => {
      if (!this.el.ended) this.events.onState('paused')
    })
    this.el.addEventListener('waiting', () => this.events.onState('buffering'))
    this.el.addEventListener('ended', () => this.events.onState('ended'))
    this.el.addEventListener('loadedmetadata', () => {
      const live = !Number.isFinite(this.el.duration)
      this.events.onMeta({ live })
      if (!live && this.startAt > 0) this.el.currentTime = this.startAt
      this.startAt = 0
    })
    this.el.addEventListener('error', () => {
      if (!this.el.getAttribute('src')) return
      this.events.onError('This link is not a playable audio file or stream.')
    })
  }

  load(track: Track, autoplay: boolean, startAt = 0) {
    this.startAt = startAt
    this.el.src = track.url
    if (autoplay) {
      this.events.onState('buffering')
      this.el.play().catch(() => this.events.onState('paused'))
    } else {
      this.events.onState('paused')
    }
  }

  play() {
    this.el.play().catch(() => this.events.onState('paused'))
  }

  pause() {
    this.el.pause()
  }

  stop() {
    this.el.pause()
    this.el.removeAttribute('src')
    this.el.load()
  }

  seek(seconds: number) {
    if (Number.isFinite(this.el.duration)) this.el.currentTime = seconds
  }

  setVolume(v: number) {
    this.el.volume = v
  }

  getPosition() {
    return this.el.currentTime || 0
  }

  getDuration() {
    return Number.isFinite(this.el.duration) ? this.el.duration : 0
  }
}
