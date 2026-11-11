/**
 * The music player: one queue for the whole app, played through whichever adapter
 * fits the track (YouTube, SoundCloud, plain audio).
 *
 * What is kept where:
 *  - this device (localStorage): the queue, what is playing in it and where, volume,
 *    shuffle and repeat. They are about this device, like a phone's own player.
 *  - the server: the music library (every track added) and playlists, so they are the
 *    same on every device. Tracks are saved there when they are added (`trackId`).
 *
 * YouTube tracks have two ways to play. Through the server (Settings → Music, on by
 * default): the Anemo server fetches the video's audio and it plays in the plain audio
 * element, which keeps going while the app is out of sight and answers the media keys
 * and the lock screen. Or through YouTube's own embedded player: when that setting is
 * off, for live streams, and for any track the server could not fetch.
 *
 * Kept from Pomidori on purpose:
 *  - resume-if-interrupted: some players (YouTube on phones) pause themselves when the
 *    page is hidden; that pause is undone, patiently. A pause that comes at any other
 *    time is somebody's doing (a media key, the phone's media notification) and stands.
 *  - skipping unplayable tracks: up to 3 in a row, then it stops and says why.
 *  - one hidden player host for the whole session (host.ts).
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { api, errorMessage, unwrap } from '@/api/client'
import { toast } from '@/components/ui/toast'
import { islandAlert } from '@/features/island/alerts'
import { msg, plural, t } from '@/lib/i18n'
import { AudioAdapter } from './audio'
import { artworkSrc, audioTitle, detectSource, fetchOEmbed, youtubeThumb } from './detect'
import { SoundCloudAdapter } from './soundcloud'
import type { Adapter, AdapterEvents, AdapterState, SourceKind, Track } from './types'
import { expandYouTubePlaylist, YouTubeAdapter } from './youtube'

export type Repeat = 'off' | 'all' | 'one'

interface PlayerData {
  queue: Track[]
  index: number
  volume: number
  /** The volume to go back to after unmuting. */
  lastVolume: number
  shuffle: boolean
  repeat: Repeat
  /** Where the current track was (seconds), to carry on after a reload. */
  position: number
}

export interface PlayerRuntime {
  status: AdapterState
  position: number
  duration: number
  /** Whether the current track has been loaded into a player in this session. */
  loaded: boolean
  error: string | null
  /** The error was YouTube refusing to play here (offer the YouTube check). */
  blocked: boolean
  adding: boolean
}

export const usePlayerStore = create<PlayerData>()(
  persist(
    (): PlayerData => ({ queue: [], index: 0, volume: 0.7, lastVolume: 0.7, shuffle: false, repeat: 'all', position: 0 }),
    { name: 'anemo-player', version: 1 },
  ),
)

export const usePlayerRuntime = create<PlayerRuntime>(() => ({
  status: 'unstarted',
  position: 0,
  duration: 0,
  loaded: false,
  error: null,
  blocked: false,
  adding: false,
}))

/** Settings → Music (copied in by <PlayerEngine>). */
let trackAlerts = true
let serverAudio = true
export function setPlayerPrefs(prefs: { trackAlerts: boolean; serverAudio: boolean }): void {
  trackAlerts = prefs.trackAlerts
  serverAudio = prefs.serverAudio
}

/* ───────────── YouTube through the server ───────────── */

/** Videos the server could not fetch in this session: they play through YouTube's own player. */
const serverRefused = new Set<string>()
/** That many in a row and the server is left alone for the rest of the session. */
export const MAX_SERVER_FAILURES = 3
let serverFailures = 0
let serverGivenUp = false
let serverProblemTold = false
let preparedFor: string | null = null

/** Whether this track's audio comes from the Anemo server (and plays in the audio element). */
export function viaServer(t: Pick<Track, 'source' | 'ref' | 'live'>): boolean {
  return serverAudio && !serverGivenUp && t.source === 'youtube' && !t.live && !serverRefused.has(t.ref)
}

/** Which player a track goes to. */
function engineOf(t: Pick<Track, 'source' | 'ref' | 'live'>): SourceKind {
  return viaServer(t) ? 'audio' : t.source
}

/** The track as its player needs it: with the server's address for its audio. */
function playable(t: Track): Track {
  return viaServer(t) ? { ...t, url: `/api/music/audio/youtube/${t.ref}` } : t
}

/** Says once, in the server's own words, why YouTube's player is used after all. */
async function tellServerProblem(videoId: string) {
  if (serverProblemTold) return
  serverProblemTold = true
  let reason = t('Anemo’s server could not fetch the audio.')
  try {
    // Asked for one byte: all that is wanted is the error it answers with.
    const answer = await api.GET('/api/music/audio/youtube/{video_id}', {
      params: { path: { video_id: videoId }, header: { Range: 'bytes=0-0' } },
      parseAs: 'stream',
    })
    // (A body that was already read as the error cannot be cancelled: nothing to do then.)
    void answer.response.body?.cancel().catch(() => undefined)
    unwrap(answer)
  } catch (err) {
    reason = errorMessage(err)
  }
  toast({ message: t('Playing through YouTube’s own player, which stops when the app is out of sight. {reason}', { reason }), duration: 10_000 })
}

/** The server could not fetch this track: the same track again, through YouTube's own player. */
function fallBackToEmbed(track: Track) {
  serverRefused.add(track.ref)
  serverFailures++
  if (serverFailures >= MAX_SERVER_FAILURES) serverGivenUp = true
  void tellServerProblem(track.ref)
  const wanted = wantsPlayback
  const { index, position } = usePlayerStore.getState()
  loadIndex(index, wanted, usePlayerRuntime.getState().position || position)
}

/** Has the server look up the next track's audio now, so it starts without the wait. */
function prepareNext() {
  const next = upNext(usePlayerStore.getState())?.track
  if (!next || !viaServer(next) || preparedFor === next.ref) return
  preparedFor = next.ref
  void api
    .POST('/api/music/audio/youtube/{video_id}/prepare', { params: { path: { video_id: next.ref } } })
    .catch(() => undefined) // it is looked up when it plays, then
}

const adapters: Partial<Record<SourceKind, Adapter>> = {}
let activeSource: SourceKind | null = null
let poll: ReturnType<typeof setInterval> | null = null
let lastAnnounced: string | null = null

/* Whether the user wants music playing; a pause that merely happened to it is undone. */
let wantsPlayback = false

/*
 * Whose pause is it, when a player stops without this app having asked?
 *  - The page went out of sight: some players stop right then, and stop again right after
 *    each try to start them while it stays out of sight. That is an interruption.
 *  - Otherwise, after it had been playing for a moment, it is somebody's doing: a media
 *    key, a headset button, the pause button of the phone's media notification. Those
 *    reach the embedded player directly, not this app, and they stand.
 */
const INTERRUPTION_WINDOW_MS = 1500
/** How long it must have been playing for a pause to count as somebody's (not a hiccup while starting). */
const STEADY_MS = 1500
let hiddenAt = -Infinity
let triedAt = -Infinity
let playingSince = 0
/** The music was paused from outside the app: when it plays again, that was asked for too. */
let pausedOutside = false

function interrupted(): boolean {
  if (typeof document === 'undefined' || document.visibilityState === 'visible') return false
  const now = Date.now()
  return now - hiddenAt < INTERRUPTION_WINDOW_MS || now - triedAt < INTERRUPTION_WINDOW_MS
}
let resumeTries = 0
let resumeTimer: ReturnType<typeof setTimeout> | null = null
/** Gaps between tries: quick at first, then patient, so a background tab doesn't use them all at once. */
const RESUME_DELAYS = [300, 1000, 2500, 6000, 15_000, 30_000]
const MAX_RESUME_TRIES = 20

function resumeIfInterrupted() {
  if (!wantsPlayback || resumeTimer || resumeTries >= MAX_RESUME_TRIES) return
  const delay = RESUME_DELAYS[Math.min(resumeTries, RESUME_DELAYS.length - 1)]
  resumeTimer = setTimeout(() => {
    resumeTimer = null
    const t = currentTrack()
    const s = usePlayerRuntime.getState().status
    if (!wantsPlayback || !t || s === 'playing' || s === 'buffering') return
    resumeTries++
    triedAt = Date.now()
    adapterFor(engineOf(t)).play()
    // If the player stays paused without saying so again, keep trying.
    setTimeout(() => {
      if (usePlayerRuntime.getState().status === 'paused') resumeIfInterrupted()
    }, 1500)
  }, delay)
}

/** Tracks in a row that could not play; reset as soon as something plays. */
let failedInARow = 0
let blockedInARow = 0
export const MAX_SKIPS = 3

/** The user asked for music: unplayable-track skipping gets a fresh budget. */
function userStarted() {
  failedInARow = 0
  blockedInARow = 0
}

if (typeof document !== 'undefined') {
  // Back to the tab: pick up again if something paused us while we were away.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      hiddenAt = Date.now()
      return
    }
    resumeTries = 0
    if (wantsPlayback && usePlayerRuntime.getState().status === 'paused') resumeIfInterrupted()
  })
}

function setRuntime(patch: Partial<PlayerRuntime>) {
  usePlayerRuntime.setState(patch)
}

function currentTrack(): Track | null {
  const { queue, index } = usePlayerStore.getState()
  return queue[index] ?? null
}

let counter = 0
export function uid(): string {
  counter += 1
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Math.random())
  return `${random}-${counter}`
}

/** A copy with its own id, so the queue and a playlist can each reorder their own. */
export function copyTrack(t: Track): Track {
  return { ...t, id: uid() }
}

function shuffled<T>(items: T[]): T[] {
  const a = [...items]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function patchQueue(match: (t: Track) => boolean, patch: Partial<Track>) {
  usePlayerStore.setState((p) => ({ queue: p.queue.map((t) => (match(t) ? { ...t, ...patch } : t)) }))
}

/* ───────────── the music library on the server ───────────── */

type LibraryTrack = { id: string; source: SourceKind; ref: string; url: string; title: string; artist: string; artwork: string | null; live: boolean }

/** Listeners told when the library changed from here (the Music page refreshes its lists). */
const libraryListeners = new Set<() => void>()
export function onLibraryChanged(fn: () => void): () => void {
  libraryListeners.add(fn)
  return () => libraryListeners.delete(fn)
}

/**
 * Save tracks to the library and note their library ids (in the queue too). Works
 * offline as well: then the tracks just have no id yet, and get one next time.
 */
export async function saveToLibrary(tracks: Track[]): Promise<Track[]> {
  if (!tracks.length) return tracks
  try {
    const saved = unwrap(
      await api.POST('/api/music/tracks', {
        body: {
          tracks: tracks.map((t) => ({
            source: t.source, ref: t.ref, url: t.url, title: t.title.slice(0, 300),
            artist: t.artist.slice(0, 300), artwork: t.artwork, live: !!t.live,
          })),
        },
      }),
    ) as LibraryTrack[]
    const withIds = tracks.map((t, i) => ({ ...t, trackId: saved[i]?.id ?? t.trackId }))
    const byKey = new Map(withIds.map((t) => [`${t.source}:${t.ref}`, t.trackId]))
    usePlayerStore.setState((p) => ({
      queue: p.queue.map((q) => (byKey.has(`${q.source}:${q.ref}`) ? { ...q, trackId: byKey.get(`${q.source}:${q.ref}`) } : q)),
    }))
    libraryListeners.forEach((fn) => fn())
    return withIds
  } catch {
    return tracks
  }
}

/** A queue entry for a track from the library (a playlist's track). */
export function fromLibrary(t: LibraryTrack): Track {
  return { id: uid(), trackId: t.id, source: t.source, ref: t.ref, url: t.url, title: t.title, artist: t.artist, artwork: t.artwork, live: t.live }
}

/* ───────────── adapters ───────────── */

function placeholderTitle(t: Pick<Track, 'source'>): string {
  return t.source === 'youtube' ? 'YouTube video' : t.source === 'soundcloud' ? 'SoundCloud track' : 'Audio stream'
}

function eventsFor(source: SourceKind): AdapterEvents {
  return {
    onState(state) {
      if (activeSource !== source) return
      const before = usePlayerRuntime.getState().status
      setRuntime({ status: state, ...(state === 'playing' ? { error: null, blocked: false } : {}) })
      if (state === 'playing') {
        if (before !== 'playing') playingSince = Date.now()
        // Started again from where it was paused: outside the app (the play key).
        if (pausedOutside) {
          pausedOutside = false
          wantsPlayback = true
        }
        resumeTries = 0
        failedInARow = 0
        blockedInARow = 0
        startPolling()
        const t = currentTrack()
        if (t && source === 'audio' && viaServer(t)) {
          serverFailures = 0
          prepareNext()
        }
        if (t && lastAnnounced !== t.id) {
          lastAnnounced = t.id
          if (trackAlerts) {
            islandAlert({ title: t.title, body: t.artist || undefined, icon: 'music', image: artworkSrc(t.artwork), tone: 'info', duration: 2400, key: 'now-playing', deferrable: true })
          }
        }
      } else if (state === 'ended') {
        stopPolling()
        handleEnded()
      } else if (state === 'paused') {
        sample()
        const steady = before === 'playing' && Date.now() - playingSince >= STEADY_MS
        if (wantsPlayback && steady && !interrupted()) {
          // Somebody paused it where this app does not see the press: it stays paused.
          wantsPlayback = false
          pausedOutside = true
        } else {
          resumeIfInterrupted()
        }
      }
      updateMediaSession()
    },
    onMeta(meta) {
      if (activeSource !== source) return
      const t = currentTrack()
      if (!t) return
      const patch: Partial<Track> = {}
      // Keep the oEmbed title unless the player knows better (SoundCloud sets change per sound).
      if (meta.title && (t.title === placeholderTitle(t) || source === 'soundcloud')) patch.title = meta.title
      if (meta.artist && (!t.artist || source === 'soundcloud')) patch.artist = meta.artist
      if (meta.artwork && source === 'soundcloud') patch.artwork = meta.artwork
      if (meta.live !== undefined && meta.live !== !!t.live) patch.live = meta.live
      if (!Object.keys(patch).length) return
      patchQueue((q) => q.id === t.id, patch)
      if (patch.title || patch.live !== undefined) void saveToLibrary([{ ...t, ...patch }])
      updateMediaSession()
    },
    onError(message, kind) {
      if (activeSource !== source) return
      const wanted = wantsPlayback
      const failed = currentTrack()
      // Not the track's fault: the server could not fetch it. YouTube's own player can try.
      if (source === 'audio' && failed && viaServer(failed)) return fallBackToEmbed(failed)
      failedInARow++
      blockedInARow = kind === 'blocked' ? blockedInARow + 1 : 0
      // Like other players: skip a track that can't play instead of stopping the queue.
      const next = wanted && failedInARow < MAX_SKIPS ? nextIndex(1) : null
      if (next !== null && next !== usePlayerStore.getState().index) {
        islandAlert({ title: t("Skipped a track that can't play"), body: failed?.title, icon: 'skip', tone: 'warning', duration: 2600 })
        loadIndex(next, true)
        return
      }
      wantsPlayback = false
      const diagnosis =
        blockedInARow >= 2
          ? t("YouTube refused several tracks in a row. That's usually an ad or privacy blocker hiding which site is playing them: allow this site in the blocker (or try a private window) and press play again.")
          : message
      setRuntime({ error: diagnosis, blocked: kind === 'blocked', status: 'paused' })
      islandAlert({ title: t("Can't play this"), body: diagnosis, icon: 'warning', tone: 'error', duration: 5000 })
    },
  }
}

function adapterFor(source: SourceKind): Adapter {
  let a = adapters[source]
  if (!a) {
    const ev = eventsFor(source)
    a = source === 'youtube' ? new YouTubeAdapter(ev) : source === 'soundcloud' ? new SoundCloudAdapter(ev) : new AudioAdapter(ev)
    a.setVolume(usePlayerStore.getState().volume)
    adapters[source] = a
  }
  return a
}

let lastSaved = 0
function sample() {
  const a = activeSource ? adapters[activeSource] : null
  if (!a) return
  const position = a.getPosition()
  setRuntime({ position, duration: a.getDuration() })
  // Remember where we are now and then (not every half second: it is written to storage).
  if (Math.abs(position - lastSaved) >= 5) {
    lastSaved = position
    usePlayerStore.setState({ position })
  }
}

function startPolling() {
  if (!poll) poll = setInterval(sample, 500)
}

function stopPolling() {
  if (poll) clearInterval(poll)
  poll = null
}

function loadIndex(index: number, autoplay: boolean, startAt = 0) {
  const { queue } = usePlayerStore.getState()
  const track = queue[index]
  if (!track) return
  usePlayerStore.setState({ index, position: startAt })
  lastSaved = startAt
  const engine = engineOf(track)
  if (activeSource && activeSource !== engine) adapters[activeSource]?.stop()
  activeSource = engine
  wantsPlayback = autoplay
  pausedOutside = false
  resumeTries = 0
  setRuntime({ position: startAt, duration: 0, loaded: true, error: null, blocked: false, status: autoplay ? 'buffering' : 'paused' })
  adapterFor(engine).load(playable(track), autoplay, track.live ? 0 : startAt)
  updateMediaSession()
}

/** The next (1) or previous (-1) index, following shuffle and repeat; null at an end. */
export function nextIndex(direction: 1 | -1): number | null {
  const { queue, index, shuffle, repeat } = usePlayerStore.getState()
  if (!queue.length) return null
  if (shuffle && queue.length > 1 && direction === 1) {
    let n = index
    while (n === index) n = Math.floor(Math.random() * queue.length)
    return n
  }
  const n = index + direction
  if (n >= 0 && n < queue.length) return n
  if (repeat === 'all') return (n + queue.length) % queue.length
  return null
}

function handleEnded() {
  if (usePlayerStore.getState().repeat === 'one') {
    const a = activeSource ? adapters[activeSource] : null
    a?.seek(0)
    a?.play()
    return
  }
  const n = nextIndex(1)
  if (n === null) {
    wantsPlayback = false
    setRuntime({ status: 'paused', position: 0 })
    return
  }
  loadIndex(n, true)
}

/* ───────────── Media Session: media keys and the phone's lock screen ───────────── */

function updateMediaSession() {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
  const t = currentTrack()
  if (!t || !usePlayerRuntime.getState().loaded) {
    navigator.mediaSession.metadata = null
    return
  }
  const art = artworkSrc(t.artwork)
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title,
    artist: t.artist,
    album: 'Anemo',
    artwork: art ? [{ src: art, sizes: '320x180' }] : [],
  })
  const s = usePlayerRuntime.getState().status
  navigator.mediaSession.playbackState = s === 'playing' || wantsPlayback ? 'playing' : 'paused'
}

let mediaSessionBound = false
function bindMediaSession() {
  if (mediaSessionBound || typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
  mediaSessionBound = true
  const ms = navigator.mediaSession
  const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
    ['play', () => player.play()],
    ['pause', () => player.pause()],
    ['nexttrack', () => player.next()],
    ['previoustrack', () => player.prev()],
    ['seekto', (d) => d.seekTime != null && player.seek(d.seekTime)],
    ['seekforward', (d) => player.seek(usePlayerRuntime.getState().position + (d.seekOffset ?? 10))],
    ['seekbackward', (d) => player.seek(Math.max(0, usePlayerRuntime.getState().position - (d.seekOffset ?? 10)))],
  ]
  for (const [action, handler] of handlers) {
    try {
      ms.setActionHandler(action, handler)
    } catch {
      // this browser does not support that action
    }
  }
}

/* ───────────── turning a pasted link into tracks ───────────── */

/** For a link to a video inside a YouTube playlist: queue the whole list, or the video only. */
export type PlaylistChoice = 'all' | 'video'

export async function buildTracks(input: string, choice: PlaylistChoice = 'all'): Promise<Track[]> {
  const detected = detectSource(input)
  if (!detected) throw new Error(t('Paste a YouTube, SoundCloud or audio link.'))

  if (detected.kind === 'youtube-playlist' || (detected.kind === 'youtube' && detected.listId && choice === 'all')) {
    const ids = await expandYouTubePlaylist(detected.listId!)
    return ids.map((id) => ({
      id: uid(), source: 'youtube' as const, ref: id, url: `https://www.youtube.com/watch?v=${id}`,
      title: 'YouTube video', artist: '', artwork: youtubeThumb(id),
    }))
  }

  if (detected.kind === 'youtube') {
    const track: Track = {
      id: uid(), source: 'youtube', ref: detected.videoId, url: `https://www.youtube.com/watch?v=${detected.videoId}`,
      title: 'YouTube video', artist: '', artwork: youtubeThumb(detected.videoId),
    }
    const meta = await fetchOEmbed('youtube', track.url)
    if (meta?.title) track.title = meta.title
    if (meta?.artist) track.artist = meta.artist
    return [track]
  }

  if (detected.kind === 'soundcloud') {
    const meta = await fetchOEmbed('soundcloud', detected.url)
    if (!meta) throw new Error(t("SoundCloud didn't recognise that link (is it private?)."))
    return [{
      id: uid(), source: 'soundcloud', ref: detected.url, url: detected.url,
      title: meta.title ?? 'SoundCloud track', artist: meta.artist ?? '', artwork: meta.artwork,
    }]
  }

  return [{ id: uid(), source: 'audio', ref: detected.url, url: detected.url, ...audioTitle(detected.url), artwork: null }]
}

/** Fill in the titles of playlist videos a few at a time, then save them to the library. */
async function hydrateTitles(tracks: Track[]) {
  const pending = tracks.filter((t) => t.source === 'youtube' && t.title === 'YouTube video').slice(0, 100)
  const done: Track[] = []
  for (let i = 0; i < pending.length; i += 6) {
    await Promise.all(
      pending.slice(i, i + 6).map(async (t) => {
        const meta = await fetchOEmbed('youtube', t.url)
        if (!meta?.title) return
        const patch = { title: meta.title, artist: meta.artist ?? '' }
        patchQueue((q) => q.source === t.source && q.ref === t.ref, patch)
        done.push({ ...t, ...patch })
      }),
    )
  }
  if (done.length) await saveToLibrary(done)
}

/* ───────────── what the app calls ───────────── */

export const player = {
  /** Add a pasted link to the end of the queue (and the library). Starts playing if nothing was. */
  async add(input: string, opts: { playNow?: boolean; choice?: PlaylistChoice } = {}): Promise<Track[]> {
    bindMediaSession()
    setRuntime({ adding: true, error: null, blocked: false })
    try {
      const tracks = await buildTracks(input, opts.choice)
      player.append(tracks, { playNow: opts.playNow, announce: true })
      void saveToLibrary(tracks).then((saved) => hydrateTitles(saved))
      return tracks
    } catch (err) {
      const message = err instanceof Error ? err.message : t("Couldn't add that link.")
      throw new Error(message)
    } finally {
      setRuntime({ adding: false })
    }
  },
  /** Put tracks at the end of the queue. */
  append(tracks: Track[], opts: { playNow?: boolean; announce?: boolean; label?: string } = {}) {
    if (!tracks.length) return
    bindMediaSession()
    const wasIdle = !usePlayerRuntime.getState().loaded || !usePlayerStore.getState().queue.length
    const startAt = usePlayerStore.getState().queue.length
    usePlayerStore.setState((p) => ({ queue: [...p.queue, ...tracks.map((t) => (p.queue.some((q) => q.id === t.id) ? copyTrack(t) : t))] }))
    if (opts.announce !== false) {
      islandAlert({
        title: tracks.length > 1 ? plural(tracks.length, 'Added {n} track', 'Added {n} tracks') : t('Added to the queue'),
        body: opts.label ?? (tracks.length === 1 ? tracks[0].title : undefined),
        icon: 'plus',
        image: tracks.length === 1 ? artworkSrc(tracks[0].artwork) : null,
        tone: 'info',
        duration: 2200,
      })
    }
    if (opts.playNow || wasIdle) {
      userStarted()
      loadIndex(startAt, true)
    }
  },
  /** Replace the queue with these tracks and play (a playlist's Play / Shuffle). */
  playTracks(tracks: Track[], opts: { shuffle?: boolean; startAt?: number } = {}) {
    if (!tracks.length) return
    bindMediaSession()
    userStarted()
    if (activeSource) adapters[activeSource]?.stop()
    let queue = tracks.map(copyTrack)
    if (opts.shuffle) queue = shuffled(queue)
    usePlayerStore.setState({ queue, index: 0 })
    loadIndex(opts.shuffle ? 0 : Math.min(opts.startAt ?? 0, queue.length - 1), true)
  },
  /** Put a track right after the one playing. */
  playNext(track: Track) {
    usePlayerStore.setState((p) => {
      const queue = p.queue.filter((t) => t.id !== track.id)
      const current = p.queue[p.index]
      const at = current ? queue.findIndex((t) => t.id === current.id) + 1 : 0
      queue.splice(at, 0, track)
      return { queue, index: current ? queue.findIndex((t) => t.id === current.id) : p.index }
    })
    islandAlert({ title: t('Plays next'), body: track.title, icon: 'plus', tone: 'info', duration: 1800 })
  },
  playIndex(index: number) {
    bindMediaSession()
    userStarted()
    loadIndex(index, true)
  },
  play() {
    bindMediaSession()
    const t = currentTrack()
    if (!t) return
    userStarted()
    const rt = usePlayerRuntime.getState()
    // Nothing loaded yet (a reload), or the player holds nothing playable after an error.
    if (!rt.loaded || activeSource !== engineOf(t) || rt.error) {
      loadIndex(usePlayerStore.getState().index, true, rt.loaded ? 0 : usePlayerStore.getState().position)
      return
    }
    wantsPlayback = true
    pausedOutside = false
    resumeTries = 0
    adapterFor(engineOf(t)).play()
  },
  pause() {
    wantsPlayback = false
    pausedOutside = false
    if (activeSource) adapters[activeSource]?.pause()
    sample()
  },
  toggle() {
    const s = usePlayerRuntime.getState().status
    if (s === 'playing' || s === 'buffering') player.pause()
    else player.play()
  },
  next() {
    userStarted()
    const a = activeSource ? adapters[activeSource] : null
    if (a?.next?.()) return
    const n = nextIndex(1)
    if (n !== null) loadIndex(n, true)
  },
  prev() {
    userStarted()
    const a = activeSource ? adapters[activeSource] : null
    if (a && a.getPosition() > 4) {
      a.seek(0)
      return
    }
    if (a?.prev?.()) return
    const n = nextIndex(-1)
    if (n !== null) loadIndex(n, true)
  },
  seek(seconds: number) {
    const a = activeSource ? adapters[activeSource] : null
    a?.seek(seconds)
    setRuntime({ position: seconds })
    usePlayerStore.setState({ position: seconds })
  },
  setVolume(volume: number) {
    const v = Math.min(1, Math.max(0, volume))
    usePlayerStore.setState((p) => ({ volume: v, lastVolume: v > 0 ? v : p.lastVolume }))
    Object.values(adapters).forEach((a) => a?.setVolume(v))
  },
  toggleMute() {
    const { volume, lastVolume } = usePlayerStore.getState()
    player.setVolume(volume > 0 ? 0 : lastVolume || 0.7)
  },
  toggleShuffle() {
    const shuffle = !usePlayerStore.getState().shuffle
    usePlayerStore.setState({ shuffle })
    islandAlert({ title: shuffle ? t('Shuffle on') : t('Shuffle off'), icon: 'shuffle', tone: 'info', duration: 1400, key: 'play-mode' })
  },
  cycleRepeat() {
    const order: Repeat[] = ['off', 'all', 'one']
    const repeat = order[(order.indexOf(usePlayerStore.getState().repeat) + 1) % 3]
    usePlayerStore.setState({ repeat })
    islandAlert({ title: t(REPEAT_LABEL[repeat]), icon: 'repeat', tone: 'info', duration: 1400, key: 'play-mode' })
  },
  /** Remove from the queue, with Undo (puts it back where it was). */
  remove(id: string) {
    const { queue, index } = usePlayerStore.getState()
    const i = queue.findIndex((t) => t.id === id)
    if (i < 0) return
    const track = queue[i]
    const removingCurrent = i === index
    const rest = queue.filter((t) => t.id !== id)
    const newIndex = i < index ? index - 1 : Math.min(index, Math.max(0, rest.length - 1))
    usePlayerStore.setState({ queue: rest, index: newIndex })
    if (removingCurrent) {
      // Still loading counts as playing: removing a track that is buffering goes on to the next.
      const status = usePlayerRuntime.getState().status
      const wasPlaying = status === 'playing' || status === 'buffering'
      if (rest.length && wasPlaying) loadIndex(newIndex, true)
      else {
        wantsPlayback = false
        if (activeSource) adapters[activeSource]?.stop()
        setRuntime({ status: 'unstarted', loaded: false, position: 0, duration: 0 })
        updateMediaSession()
      }
    }
    toast({
      message: t('Removed “{title}”', { title: track.title }),
      action: {
        label: t('Undo'),
        onClick: () =>
          usePlayerStore.setState((p) => {
            if (p.queue.some((t) => t.id === track.id)) return p
            const at = Math.min(i, p.queue.length)
            const q = [...p.queue]
            q.splice(at, 0, track)
            return { queue: q, index: p.queue.length && at <= p.index ? p.index + 1 : p.index }
          }),
      },
    })
  },
  /** The queue in a new order (ids of its entries). */
  reorder(ids: string[]) {
    usePlayerStore.setState((p) => {
      const current = p.queue[p.index]?.id
      const byId = new Map(p.queue.map((t) => [t.id, t]))
      const queue = ids.map((id) => byId.get(id)).filter((t): t is Track => !!t)
      return { queue, index: Math.max(0, queue.findIndex((t) => t.id === current)) }
    })
  },
  /** Move one entry up (-1) or down (1): the keyboard way to reorder. */
  move(id: string, by: -1 | 1) {
    const ids = usePlayerStore.getState().queue.map((t) => t.id)
    const i = ids.indexOf(id)
    const j = i + by
    if (i < 0 || j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    player.reorder(ids)
  },
  clear() {
    const before = usePlayerStore.getState()
    wantsPlayback = false
    if (activeSource) adapters[activeSource]?.stop()
    usePlayerStore.setState({ queue: [], index: 0, position: 0 })
    setRuntime({ status: 'unstarted', loaded: false, position: 0, duration: 0, error: null, blocked: false })
    lastAnnounced = null
    updateMediaSession()
    if (before.queue.length) {
      toast({
        message: t('Queue cleared'),
        action: { label: t('Undo'), onClick: () => usePlayerStore.setState({ queue: before.queue, index: before.index }) },
      })
    }
  },
}

export const REPEAT_LABEL: Record<Repeat, string> = { off: msg('Repeat off'), all: msg('Repeat the queue'), one: msg('Repeat this track') }

/** Everything a player display needs. */
export function usePlayer() {
  const data = usePlayerStore()
  const rt = usePlayerRuntime()
  const track = data.queue[data.index] ?? null
  return {
    ...data,
    ...rt,
    track,
    playing: rt.status === 'playing' || rt.status === 'buffering',
    /** Something to show (the Island): a track that has been played in this session. */
    active: !!track && rt.loaded,
  }
}

/** The track that plays after the current one, if it is known (not while shuffling). */
export function upNext(p: { queue: Track[]; index: number; shuffle: boolean; repeat: Repeat }): { index: number; track: Track } | null {
  if (p.shuffle || p.queue.length < 2) return null
  const n = p.index + 1 < p.queue.length ? p.index + 1 : p.repeat === 'all' ? 0 : -1
  return n >= 0 ? { index: n, track: p.queue[n] } : null
}
