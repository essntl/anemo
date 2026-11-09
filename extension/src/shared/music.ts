/**
 * Music controls (feature 11): the player in an Anemo tab of this Chrome, driven from the
 * panel. A small script of ours in Anemo tabs (inpage/anemoBridge) passes commands to
 * Anemo's page and what is playing back to the extension (Anemo's
 * features/music/extensionBridge.ts is the other end). The extension can add to the end
 * of the queue; it never replaces or clears it.
 */

/** Sent to the Anemo page (the names are the page's). */
export type MusicCommand =
  | { type: 'hello' }
  | { type: 'toggle' }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'add'; url: string; id: string }

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

export interface MusicTab {
  tabId: number
  state: NowPlaying
  at: number
}

export const BRIDGE_SCRIPT = 'inpage/anemoBridge.js'
export const BRIDGE_ID = 'anemo-bridge'

function text(v: unknown, max: number): string | null {
  return typeof v === 'string' ? v.slice(0, max) : null
}

/** A state from the page, checked field by field (it is the Anemo page's, but still data). */
export function cleanState(raw: unknown): NowPlaying | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0)
  return {
    status: text(r.status, 20) ?? 'unstarted',
    title: text(r.title, 300),
    artist: text(r.artist, 300),
    url: text(r.url, 2000),
    index: num(r.index),
    queueLength: num(r.queueLength),
    adding: r.adding === true,
    error: text(r.error, 300),
  }
}

/** The tab to control: the one playing, else the one heard from last. */
export function pickTab(tabs: MusicTab[]): MusicTab | null {
  const playing = tabs.filter((t) => t.state.status === 'playing' || t.state.status === 'buffering')
  const pool = playing.length ? playing : tabs
  return pool.reduce<MusicTab | null>((best, t) => (!best || t.at > best.at ? t : best), null)
}

/** A YouTube or SoundCloud address (the "add this tab" button). */
export function isMusicPage(url: string | undefined): boolean {
  if (!url) return false
  try {
    const host = new URL(url).hostname.replace(/^(www|m|music)\./, '')
    return ['youtube.com', 'youtu.be', 'soundcloud.com'].includes(host)
  } catch {
    return false
  }
}
