/** The YouTube player in a tab, driven from the panel (needs access to youtube.com). */
import { fetchTranscriptRaw, grabFrame, readPlayer, seekPlayer, setPlaying, type PlayerState, type TranscriptRaw } from '@/shared/youtubePage'
import { segmentsFromRaw, type Segment } from '@/shared/youtube'

async function run<T>(tabId: number, func: (...args: never[]) => T | Promise<T>, args: unknown[] = [], world: 'ISOLATED' | 'MAIN' = 'ISOLATED'): Promise<T | null> {
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, world, func: func as () => T, args: args as [] })
    return (r?.result as T) ?? null
  } catch {
    return null
  }
}

export const player = {
  state: (tabId: number) => run<PlayerState>(tabId, readPlayer),
  seek: (tabId: number, seconds: number) => run<boolean>(tabId, seekPlayer as never, [seconds]),
  play: (tabId: number, play: boolean) => run<boolean>(tabId, setPlaying as never, [play]),
  frame: (tabId: number) => run<string | null>(tabId, grabFrame),
  async transcript(tabId: number, videoId: string): Promise<{ segments: Segment[]; reason?: string }> {
    const raw = await run<TranscriptRaw>(tabId, fetchTranscriptRaw as never, [videoId], 'MAIN')
    if (!raw) return { segments: [], reason: 'The transcript couldn’t be read from the page.' }
    const segments = segmentsFromRaw(raw)
    return segments.length ? { segments } : { segments, reason: raw.kind === 'none' ? raw.reason : 'This video has no transcript.' }
  },
}
