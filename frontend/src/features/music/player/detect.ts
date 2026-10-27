import type { SourceKind } from './types'

export type Detected =
  /** A video; `listId` when the link was a video inside a playlist. */
  | { kind: 'youtube'; videoId: string; listId?: string; url: string }
  | { kind: 'youtube-playlist'; listId: string; url: string }
  | { kind: 'soundcloud'; url: string }
  | { kind: 'audio'; url: string }

const YT_ID = /^[a-zA-Z0-9_-]{11}$/

/** Which kind of link was pasted. Null when it is not a usable web address. */
export function detectSource(input: string): Detected | null {
  const raw = input.trim()
  if (!raw || /\s/.test(raw)) return null
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!url.hostname.includes('.') && url.hostname !== 'localhost') return null
  const host = url.hostname.replace(/^(www|m)\./, '')

  if (host === 'youtu.be') {
    const id = url.pathname.slice(1, 12)
    if (YT_ID.test(id)) {
      const list = url.searchParams.get('list')
      return { kind: 'youtube', videoId: id, url: url.href, ...(list && !list.startsWith('RD') ? { listId: list } : {}) }
    }
    return null
  }

  if (host === 'youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com') {
    const path = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([a-zA-Z0-9_-]{11})/)
    const id = url.searchParams.get('v') ?? path?.[1] ?? null
    const list = url.searchParams.get('list')
    // Mixes ("RD…") are made up on the fly for each viewer: only the video is queued.
    const usableList = list && !list.startsWith('RD') ? list : null
    if (id && YT_ID.test(id)) return { kind: 'youtube', videoId: id, url: url.href, ...(usableList ? { listId: usableList } : {}) }
    if (usableList) return { kind: 'youtube-playlist', listId: usableList, url: url.href }
    return null
  }

  if (host === 'soundcloud.com' || host === 'on.soundcloud.com' || host === 'api.soundcloud.com') {
    if (url.pathname.split('/').filter(Boolean).length >= 1) return { kind: 'soundcloud', url: url.href.split('?')[0] }
    return null
  }

  return { kind: 'audio', url: url.href }
}

export const SOURCE_LABEL: Record<SourceKind, string> = {
  youtube: 'YouTube',
  soundcloud: 'SoundCloud',
  audio: 'Stream',
}

export function youtubeThumb(id: string): string {
  return `https://i.ytimg.com/vi/${id}/mqdefault.jpg`
}

/** YouTube's 4:3 thumbnail has black bars; the 16:9 one crops cleanly. */
export function artworkSrc(url: string | null | undefined): string | null {
  return url ? url.replace('/hqdefault.jpg', '/mqdefault.jpg') : null
}

/** Title, artist and artwork from the platforms' public oEmbed endpoints (no keys needed). */
export async function fetchOEmbed(kind: 'youtube' | 'soundcloud', url: string) {
  const endpoint =
    kind === 'youtube'
      ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`
      : `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(url)}`
  try {
    const res = await fetch(endpoint)
    if (!res.ok) return null
    const data = (await res.json()) as { title?: string; author_name?: string; thumbnail_url?: string }
    return { title: data.title ?? null, artist: data.author_name ?? null, artwork: data.thumbnail_url ?? null }
  } catch {
    return null
  }
}

/** A readable title for a direct audio link: the file name, or the site. */
export function audioTitle(href: string): { title: string; artist: string } {
  const url = new URL(href)
  const file = decodeURIComponent(url.pathname.split('/').pop() ?? '')
  const hasExtension = /\.[a-z0-9]{2,4}$/i.test(file)
  return { title: hasExtension ? file.replace(/\.[a-z0-9]{2,4}$/i, '') : url.hostname, artist: url.hostname }
}
