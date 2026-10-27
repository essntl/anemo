/**
 * What an agent asks this tab to do (start_focus, queue_music). Only the tab the
 * request is for acts on it (see tab.ts).
 */
import { islandAlert } from '@/features/island/alerts'
import { timerActions } from '@/features/focus/timerStore'
import { buildTracks, fromLibrary, player } from '@/features/music/player/controller'
import type { LibraryTrack } from '@/features/music/api'
import { tabId } from './tab'

export interface FocusControl {
  tab: string
  action: 'start'
  minutes?: number | null
  task_id?: string | null
  task_title?: string | null
}

export interface MusicControl {
  tab: string
  action: 'queue'
  replace?: boolean
  url?: string
  playlist?: { name: string; tracks: LibraryTrack[] }
}

export function onFocusControl(e: FocusControl): boolean {
  if (e.tab !== tabId() || e.action !== 'start') return false
  timerActions.focusOn(e.task_id ?? null, e.minutes ?? undefined)
  islandAlert({ title: 'An agent started a focus session', body: e.task_title ?? undefined, icon: 'bot', tone: 'accent', duration: 4000, link: '/focus' })
  return true
}

export async function onMusicControl(e: MusicControl): Promise<boolean> {
  if (e.tab !== tabId() || e.action !== 'queue') return false
  try {
    const tracks = e.playlist ? e.playlist.tracks.map(fromLibrary) : await buildTracks(e.url ?? '')
    if (e.replace) player.playTracks(tracks)
    else player.append(tracks, { label: e.playlist?.name })
  } catch (err) {
    islandAlert({ title: "Couldn't queue the music", body: err instanceof Error ? err.message : undefined, icon: 'warning', tone: 'error' })
  }
  return true
}
