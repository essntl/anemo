export type SourceKind = 'youtube' | 'soundcloud' | 'audio'

/** Something to play: an entry in the queue or a playlist. */
export interface Track {
  /** Unique within its list (the same song can be in the queue twice). */
  id: string
  /** The track in the server's music library, once it is saved there. */
  trackId?: string | null
  source: SourceKind
  /** YouTube video id, or the full link for SoundCloud and audio. */
  ref: string
  url: string
  title: string
  artist: string
  artwork: string | null
  /** A live stream (radio): no length, no seeking. */
  live?: boolean
}

export type AdapterState = 'unstarted' | 'playing' | 'paused' | 'buffering' | 'ended'

export interface AdapterEvents {
  onState: (state: AdapterState) => void
  onMeta: (meta: Partial<Pick<Track, 'title' | 'artist' | 'artwork' | 'live'>>) => void
  /** `blocked`: the source refused to play here (YouTube's embedding rules). */
  onError: (message: string, kind?: 'blocked') => void
}

/** One way of playing sound: YouTube, SoundCloud or a plain audio element. */
export interface Adapter {
  /** Load a track, optionally from a position (seconds) and playing straight away. */
  load(track: Track, autoplay: boolean, startAt?: number): void
  play(): void
  pause(): void
  stop(): void
  seek(seconds: number): void
  setVolume(volume: number): void
  getPosition(): number
  getDuration(): number
  /** Sources holding several tracks (SoundCloud sets) move within them first. */
  next?(): boolean
  prev?(): boolean
}
