/**
 * What an agent asks this tab to do (start_focus, queue_music, get_music_queue,
 * music_control). Only the tab the request is for acts on it (see tab.ts).
 */
import { api } from '@/api/client'
import { islandAlert } from '@/features/island/alerts'
import { timerActions, useTimerStore } from '@/features/focus/timerStore'
import { buildTracks, fromLibrary, nextIndex, player, usePlayerRuntime, usePlayerStore } from '@/features/music/player/controller'
import type { LibraryTrack } from '@/features/music/api'
import type { Schemas } from '@/api/client'
import { tabId } from './tab'

export interface FocusControl {
  tab: string
  /** stop: end the session as the Stop button does (a focus phase is recorded as cut short). */
  action: 'start' | 'stop' | 'pause'
  minutes?: number | null
  task_id?: string | null
  task_title?: string | null
}

export interface MusicControl {
  tab: string
  /** queue: add (or replace). The others carry `request` and are answered with the player's state. */
  action: 'queue' | 'report' | 'pause' | 'resume' | 'skip' | 'remove'
  replace?: boolean
  url?: string
  playlist?: { name: string; tracks: LibraryTrack[] }
  /** The id the answer is sent back under (POST /api/music/player-state). */
  request?: string
  /** remove: the track's place in the queue, counted from 1. */
  position?: number
}

type PlayerState = Schemas['PlayerState']
const MAX_REPORTED = 500

export function onFocusControl(e: FocusControl): boolean {
  if (e.tab !== tabId()) return false
  if (e.action === 'stop' || e.action === 'pause') {
    const { status, accumulated } = useTimerStore.getState().timer
    if (e.action === 'pause' ? status !== 'running' : status === 'idle' && accumulated === 0) return true // nothing to do
    if (e.action === 'pause') timerActions.pause()
    else timerActions.reset()
    islandAlert({ title: e.action === 'pause' ? 'An agent paused the focus timer' : 'An agent stopped the focus session', icon: 'bot', tone: 'accent', duration: 4000, link: '/focus' })
    return true
  }
  if (e.action !== 'start') return false
  timerActions.focusOn(e.task_id ?? null, e.minutes ?? undefined)
  islandAlert({ title: 'An agent started a focus session', body: e.task_title ?? undefined, icon: 'bot', tone: 'accent', duration: 4000, link: '/focus' })
  return true
}

/** The player as an agent sees it: what plays and the whole queue, in order. */
export function playerState(extra: Pick<PlayerState, 'removed' | 'problem'> = {}): PlayerState {
  const { queue, index, shuffle, repeat } = usePlayerStore.getState()
  const reported = queue.slice(0, MAX_REPORTED).map(reportTrack)
  return { status: usePlayerRuntime.getState().status, index, shuffle, repeat, queue: reported, more: queue.length - reported.length, ...extra }
}

function reportTrack(t: { title: string; artist: string; url: string; live?: boolean }): Schemas['PlayerTrack'] {
  return { title: t.title.slice(0, 300), artist: t.artist.slice(0, 300), url: t.url.slice(0, 2000), live: !!t.live }
}

/** Do what a music_control call asks; what it did (or why not) goes back with the state. */
function control(e: MusicControl): Pick<PlayerState, 'removed' | 'problem'> {
  const { queue } = usePlayerStore.getState()
  if (e.action === 'report') return {}
  if (!queue.length) return { problem: 'The music queue is empty.' }
  if (e.action === 'pause') player.pause()
  else if (e.action === 'resume') player.play()
  else if (e.action === 'skip') {
    if (nextIndex(1) === null) return { problem: 'This is the last track in the queue; there is nothing to skip to.' }
    player.next()
  } else if (e.action === 'remove') {
    const track = queue[(e.position ?? 0) - 1]
    if (!track) return { problem: `There is no track at position ${e.position}; the queue has ${queue.length}.` }
    player.remove(track.id) // shows “Removed …” with Undo, as when the user removes it
    return { removed: reportTrack(track) }
  }
  return {}
}

export async function onMusicControl(e: MusicControl): Promise<boolean> {
  if (e.tab !== tabId()) return false
  if (e.action !== 'queue') {
    if (!e.request) return false
    const state = playerState(control(e))
    // The answer is for the agent's tool, which waits a few seconds; nothing to show if it is lost.
    await api.POST('/api/music/player-state', { body: { request: e.request, state } }).catch(() => undefined)
    return true
  }
  try {
    const tracks = e.playlist ? e.playlist.tracks.map(fromLibrary) : await buildTracks(e.url ?? '')
    if (e.replace) player.playTracks(tracks)
    else player.append(tracks, { label: e.playlist?.name })
  } catch (err) {
    islandAlert({ title: "Couldn't queue the music", body: err instanceof Error ? err.message : undefined, icon: 'warning', tone: 'error' })
  }
  return true
}
