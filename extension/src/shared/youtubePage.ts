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

export type TranscriptRaw =
  | { kind: 'innertube'; json: unknown }
  | { kind: 'captions'; body: string }
  | { kind: 'dom'; rows: { time: string; text: string }[] }
  | { kind: 'none'; reason: string }

/**
 * Runs in the page's MAIN world (it needs YouTube's own settings and player). Tries, in
 * order: the transcript panel if it is already open; YouTube's transcript request (as its
 * "Show transcript" panel makes it); the video's caption tracks; and last, opening the
 * transcript panel and reading it. Each answer is checked for lines before it is taken.
 */
export async function fetchTranscriptRaw(videoId: string): Promise<TranscriptRaw> {
  const TIME = /^\d{1,2}(?::\d{2}){1,2}$/
  const find = (node: unknown, key: string, depth = 0): unknown => {
    if (!node || typeof node !== 'object' || depth > 40) return undefined
    if (key in (node as Record<string, unknown>)) return (node as Record<string, unknown>)[key]
    for (const value of Object.values(node as Record<string, unknown>)) {
      const hit = find(value, key, depth + 1)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  const get = async (url: string, init: RequestInit = {}): Promise<Response | null> => {
    try {
      return await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(10_000), ...init })
    } catch {
      return null
    }
  }
  const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()

  /** The rows of a transcript panel on the page (old and new layouts, or any list of
   *  "timestamp + line" rows inside a transcript panel). */
  const readPanel = (): { time: string; text: string }[] => {
    const old = [...document.querySelectorAll('ytd-transcript-segment-renderer')]
    if (old.length) return old.map((r) => ({ time: text(r.querySelector('.segment-timestamp')), text: text(r.querySelector('.segment-text')) }))
    // Newer layouts: rows in a transcript engagement panel, or YouTube's view-model rows.
    const panels = [...document.querySelectorAll('ytd-engagement-panel-section-list-renderer')].filter((p) => /transcript/i.test(`${p.getAttribute('target-id') ?? ''} ${text(p.querySelector('#title-text, #title, h2'))}`))
    const modern = [...document.querySelectorAll('transcript-segment-view-model')]
    const scopes: Element[] = [...panels, ...(modern.length ? [modern[0].parentElement ?? document.body] : [])]
    const rows: { time: string; text: string }[] = []
    for (const scope of scopes) {
      const stamps = [...scope.querySelectorAll('*')].filter((el) => TIME.test(text(el)) && ![...el.children].some((c) => TIME.test(text(c))))
      const seen = new Set<Element>()
      for (const stamp of stamps) {
        // The row: the biggest element around the timestamp that holds no other timestamp.
        let row: Element = stamp
        while (row.parentElement && row.parentElement !== scope && stamps.filter((s) => row.parentElement!.contains(s)).length === 1) row = row.parentElement
        if (seen.has(row) || row === stamp) continue
        seen.add(row)
        const time = text(stamp)
        const parts = [...row.querySelectorAll('.segment-text, .yt-core-attributed-string, [class*="SegmentText" i]')].filter((el) => !el.contains(stamp) && !stamp.contains(el))
        const line = (parts.length ? text(parts.sort((a, b) => text(b).length - text(a).length)[0]) : text(row).replace(time, ''))
          // a spoken form of the time some layouts add for screen readers
          .replace(/^\d+\s+(hours?|minutes?|seconds?)(,?\s*\d+\s+(minutes?|seconds?))*\s*/i, '')
          .trim()
        if (line) rows.push({ time, text: line })
      }
      if (rows.length > 1) break
      rows.length = 0
    }
    return rows
  }
  const hasSegments = (json: unknown) => {
    const s = JSON.stringify(json ?? null)
    return s.includes('"transcriptSegmentRenderer"') || s.includes('"transcriptCueRenderer"')
  }
  const hasCaptions = (body: string) => (body.trim().startsWith('{') ? body.includes('"segs"') : /<(text|p)\b/.test(body))

  const w = window as unknown as {
    ytcfg?: { get?: (k: string) => unknown }
    ytInitialData?: unknown
    ytInitialPlayerResponse?: { videoDetails?: { videoId?: string } }
  }
  const here = new URLSearchParams(location.search).get('v') === videoId

  // 1. The panel is open already: read what the person sees.
  if (here) {
    const rows = readPanel()
    if (rows.length) return { kind: 'dom', rows }
  }

  // The data YouTube built this video's page from (the page's own can be stale after
  // moving to another video, so it's fetched again then).
  let initialData: unknown = here ? w.ytInitialData : undefined
  let playerResponse: unknown
  const playerEl = document.getElementById('movie_player') as (HTMLElement & { getPlayerResponse?: () => { videoDetails?: { videoId?: string } } }) | null
  try {
    const live = playerEl?.getPlayerResponse?.()
    if (live?.videoDetails?.videoId === videoId) playerResponse = live
  } catch {
    // no player API
  }
  if (!playerResponse && w.ytInitialPlayerResponse?.videoDetails?.videoId === videoId) playerResponse = w.ytInitialPlayerResponse
  const needPage = !find(initialData, 'getTranscriptEndpoint') || !playerResponse
  if (needPage) {
    const html = await (await get(`/watch?v=${encodeURIComponent(videoId)}`))?.text().catch(() => '')
    const json = (name: string) => {
      const m = new RegExp(`${name}\\s*=\\s*(\\{[\\s\\S]+?\\});\\s*(?:var |</script>)`).exec(html ?? '')
      try {
        return m ? JSON.parse(m[1]) : undefined
      } catch {
        return undefined
      }
    }
    if (!find(initialData, 'getTranscriptEndpoint')) initialData = json('ytInitialData') ?? initialData
    if (!playerResponse) playerResponse = json('ytInitialPlayerResponse')
  }

  const key = w.ytcfg?.get?.('INNERTUBE_API_KEY')
  const context = w.ytcfg?.get?.('INNERTUBE_CONTEXT') as { client?: { clientName?: string; clientVersion?: string } } | undefined
  const clientHeaders: Record<string, string> = { 'Content-Type': 'application/json' }
  const clientVersion = (w.ytcfg?.get?.('INNERTUBE_CLIENT_VERSION') as string | undefined) ?? context?.client?.clientVersion
  const clientName = w.ytcfg?.get?.('INNERTUBE_CONTEXT_CLIENT_NAME')
  if (clientName !== undefined) clientHeaders['X-Youtube-Client-Name'] = String(clientName)
  if (clientVersion) clientHeaders['X-Youtube-Client-Version'] = clientVersion
  const keyParam = key ? `key=${encodeURIComponent(String(key))}&` : ''

  // 2. YouTube's transcript request.
  const endpoint = find(initialData, 'getTranscriptEndpoint') as { params?: string } | undefined
  if (endpoint?.params && context) {
    const res = await get(`/youtubei/v1/get_transcript?${keyParam}prettyPrint=false`, { method: 'POST', headers: clientHeaders, body: JSON.stringify({ context, params: endpoint.params }) })
    const json = res?.ok ? await res.json().catch(() => null) : null
    if (hasSegments(json)) return { kind: 'innertube', json }
  }

  // 3. The caption tracks (the same lines as the transcript). Prefer tracks someone wrote
  //    over automatic ones, in the page's language.
  type Track = { baseUrl?: string; languageCode?: string; kind?: string }
  const pick = (tracks: Track[] | undefined): Track | undefined => {
    const usable = (tracks ?? []).filter((t) => t.baseUrl)
    const lang = (document.documentElement.lang || navigator.language || 'en').slice(0, 2)
    const score = (t: Track) => (t.kind !== 'asr' ? 2 : 0) + (t.languageCode?.slice(0, 2) === lang ? 1 : 0)
    return usable.sort((a, b) => score(b) - score(a))[0]
  }
  const asJson3 = (url: string) => {
    const u = new URL(url, location.origin)
    u.searchParams.set('fmt', 'json3')
    return u.toString()
  }
  const captions = async (url: string): Promise<string | null> => {
    const res = await get(url)
    const body = res?.ok ? await res.text().catch(() => '') : ''
    return body && hasCaptions(body) ? body : null
  }
  const track = pick(find(playerResponse, 'captionTracks') as Track[] | undefined)
  if (track?.baseUrl) {
    // The player's own request for these captions carries a token the plain address
    // lacks; when the captions were shown, reuse it.
    const lang = new URL(track.baseUrl, location.origin).searchParams.get('lang')
    const seen = performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .filter((n) => n.includes('/api/timedtext') && n.includes(`v=${videoId}`) && n.includes('pot='))
      .reverse()
    const own = seen.find((n) => !lang || n.includes(`lang=${lang}`)) ?? seen[0]
    for (const url of [own, track.baseUrl].filter((u): u is string => Boolean(u))) {
      const body = (await captions(asJson3(url))) ?? (await captions(url))
      if (body) return { kind: 'captions', body }
    }
  }
  // The caption tracks as YouTube's Android app gets them (their addresses need no token).
  {
    const res = await get(`/youtubei/v1/player?prettyPrint=false`, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38' } }, videoId }),
    })
    const json = res?.ok ? await res.json().catch(() => null) : null
    const t = pick(find(json, 'captionTracks') as Track[] | undefined)
    if (t?.baseUrl) {
      const plain = t.baseUrl.replace(/&fmt=[^&]*/, '')
      const body = (await captions(asJson3(plain))) ?? (await captions(plain))
      if (body) return { kind: 'captions', body }
    }
  }

  // 4. Open the transcript panel and read it.
  if (here) {
    try {
      const buttons = [
        ...document.querySelectorAll('ytd-video-description-transcript-section-renderer button, ytd-video-description-transcript-section-renderer [role="button"]'),
        ...[...document.querySelectorAll('#description button, ytd-watch-metadata button, #primary button')].filter((b) => /transcript/i.test(`${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`)),
      ] as HTMLElement[]
      buttons[0]?.click()
      for (let i = 0; i < 50; i++) {
        const rows = readPanel()
        if (rows.length) return { kind: 'dom', rows }
        await new Promise((r) => setTimeout(r, 100))
      }
    } catch {
      // nothing more to try
    }
  }
  return { kind: 'none', reason: 'YouTube didn’t give the transcript. Open “Show transcript” under the video, then try again.' }
}
