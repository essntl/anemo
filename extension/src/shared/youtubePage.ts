/**
 * Functions that run inside a YouTube tab (chrome.scripting.executeScript serialises each
 * one, so none may use imports or outside variables). They read the player and the page,
 * and seek or pause it on a click in the panel; they never send anything anywhere except
 * YouTube's own transcript request (from the page, with the page's own settings).
 */

export interface PlayerState {
  ok: boolean
  currentTime: number
  duration: number
  paused: boolean
  /** An ad is playing: no timestamps are taken now. */
  ad: boolean
  title: string
  channel: string
  url: string
}

/** Runs in the page (isolated world). */
export function readPlayer(): PlayerState {
  const video = (document.querySelector('#movie_player video') ?? document.querySelector('video')) as HTMLVideoElement | null
  const player = document.getElementById('movie_player')
  const ad = Boolean(player?.classList.contains('ad-showing') || player?.classList.contains('ad-interrupting') || document.querySelector('.ytp-ad-player-overlay, .ytp-ad-player-overlay-layout'))
  const title = (document.querySelector('ytd-watch-metadata h1, h1.ytd-watch-metadata, h1.title')?.textContent ?? '').trim() || document.title.replace(/ - YouTube$/, '').trim()
  const channel = (document.querySelector('ytd-watch-metadata ytd-channel-name a, #owner #channel-name a, ytd-channel-name a')?.textContent ?? '').trim()
  return {
    ok: Boolean(video),
    currentTime: video?.currentTime ?? 0,
    duration: Number.isFinite(video?.duration) ? (video?.duration ?? 0) : 0,
    paused: video?.paused ?? true,
    ad,
    title,
    channel,
    url: location.href,
  }
}

/** Runs in the page: jump to a moment (and keep playing if it was). */
export function seekPlayer(seconds: number): boolean {
  const video = (document.querySelector('#movie_player video') ?? document.querySelector('video')) as HTMLVideoElement | null
  if (!video) return false
  video.currentTime = Math.max(0, seconds)
  return true
}

/** Runs in the page: pause or play. Returns whether it was playing before. */
export function setPlaying(play: boolean): boolean {
  const video = (document.querySelector('#movie_player video') ?? document.querySelector('video')) as HTMLVideoElement | null
  if (!video) return false
  const wasPlaying = !video.paused
  if (play) void video.play().catch(() => undefined)
  else video.pause()
  return wasPlaying
}

/** Runs in the page: the current frame as a JPEG data URL (at most 1280 px wide). */
export function grabFrame(): string | null {
  const video = (document.querySelector('#movie_player video') ?? document.querySelector('video')) as HTMLVideoElement | null
  if (!video || !video.videoWidth) return null
  const scale = Math.min(1, 1280 / video.videoWidth)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(video.videoWidth * scale)
  canvas.height = Math.round(video.videoHeight * scale)
  try {
    canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.85)
  } catch {
    return null // a protected video can't be drawn
  }
}

export type TranscriptRaw = { kind: 'innertube'; json: unknown } | { kind: 'dom'; rows: { time: string; text: string }[] } | { kind: 'none'; reason: string }

/**
 * Runs in the page's MAIN world (it needs YouTube's own settings). Asks YouTube for the
 * transcript the way its "Show transcript" panel does; if that fails, opens that panel
 * and reads it.
 */
export async function fetchTranscriptRaw(videoId: string): Promise<TranscriptRaw> {
  const find = (node: unknown, key: string, depth = 0): unknown => {
    if (!node || typeof node !== 'object' || depth > 40) return undefined
    if (key in (node as Record<string, unknown>)) return (node as Record<string, unknown>)[key]
    for (const value of Object.values(node as Record<string, unknown>)) {
      const hit = find(value, key, depth + 1)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  try {
    const w = window as unknown as { ytcfg?: { get?: (k: string) => unknown } }
    const key = w.ytcfg?.get?.('INNERTUBE_API_KEY')
    const context = w.ytcfg?.get?.('INNERTUBE_CONTEXT')
    // The page's own data can be stale after moving to another video: read this video's.
    const html = await (await fetch(`/watch?v=${encodeURIComponent(videoId)}`, { credentials: 'include' })).text()
    const m = /ytInitialData\s*=\s*(\{[\s\S]+?\});\s*<\/script>/.exec(html)
    const endpoint = m ? (find(JSON.parse(m[1]), 'getTranscriptEndpoint') as { params?: string } | undefined) : undefined
    if (endpoint?.params && key && context) {
      const res = await fetch(`/youtubei/v1/get_transcript?key=${encodeURIComponent(String(key))}&prettyPrint=false`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context, params: endpoint.params }),
      })
      if (res.ok) return { kind: 'innertube', json: await res.json() }
    }
  } catch {
    // try the panel
  }
  try {
    let rows = [...document.querySelectorAll('ytd-transcript-segment-renderer')]
    if (rows.length === 0) {
      const button = document.querySelector('ytd-video-description-transcript-section-renderer button') as HTMLButtonElement | null
      button?.click()
      for (let i = 0; i < 30 && rows.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 100))
        rows = [...document.querySelectorAll('ytd-transcript-segment-renderer')]
      }
    }
    if (rows.length) {
      return {
        kind: 'dom',
        rows: rows.map((r) => ({
          time: (r.querySelector('.segment-timestamp')?.textContent ?? '').trim(),
          text: (r.querySelector('.segment-text')?.textContent ?? '').trim(),
        })),
      }
    }
  } catch {
    // nothing more to try
  }
  return { kind: 'none', reason: 'This video has no transcript (or YouTube didn’t give it).' }
}
