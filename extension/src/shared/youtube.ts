/**
 * YouTube notes (feature 7): one Anemo document per video, readable and clickable in Anemo
 * too:
 *
 *   # <video title>
 *
 *   Channel: <channel> · [Watch on YouTube](https://youtu.be/<id>)
 *
 *   ## Notes
 *
 *   [01:05](https://youtu.be/<id>?t=65) A note, in Markdown.
 *   It can have more lines.
 *
 *   [12:30](https://youtu.be/<id>?t=750) The next note.
 *
 * Notes are kept in time order. Anything written in the document outside "## Notes" stays as
 * it is; a note is a block that starts with its timestamp link.
 */

export type VideoRef = { kind: 'video'; id: string; list: string | null } | { kind: 'short'; id: string }

const ID = /^[A-Za-z0-9_-]{11}$/

/** The video in a YouTube address (a watch page, youtu.be, a Short), or null. */
export function parseVideoUrl(url: string | undefined | null): VideoRef | null {
  let u: URL
  try {
    u = new URL(url ?? '')
  } catch {
    return null
  }
  const host = u.hostname.replace(/^(www|m|music)\./, '')
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1)
    return ID.test(id) ? { kind: 'video', id, list: u.searchParams.get('list') } : null
  }
  if (host !== 'youtube.com') return null
  if (u.pathname === '/watch') {
    const id = u.searchParams.get('v') ?? ''
    return ID.test(id) ? { kind: 'video', id, list: u.searchParams.get('list') } : null
  }
  const short = /^\/shorts\/([A-Za-z0-9_-]{11})/.exec(u.pathname)
  if (short) return { kind: 'short', id: short[1] }
  const live = /^\/live\/([A-Za-z0-9_-]{11})/.exec(u.pathname)
  if (live) return { kind: 'video', id: live[1], list: null }
  return null
}

/** 65 → "01:05", 3725 → "1:02:05". */
export function formatTimestamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const two = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${two(m)}:${two(sec)}`
}

export function timestampLink(id: string, seconds: number): string {
  return `https://youtu.be/${id}?t=${Math.max(0, Math.floor(seconds))}`
}

export interface Note {
  seconds: number
  /** The note's Markdown (without its timestamp link). */
  text: string
}

export function noteMarkdown(id: string, note: Note): string {
  return `[${formatTimestamp(note.seconds)}](${timestampLink(id, note.seconds)}) ${note.text.trim()}`
}

const NOTES_HEADING = '## Notes'
const NOTE_START = /^\[(\d{1,2}:)?\d{1,2}:\d{2}\]\(https:\/\/youtu\.be\/[A-Za-z0-9_-]{11}\?t=(\d+)\)\s?/

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function newNotesDocument(v: { id: string; title: string; channel: string }): string {
  const channel = v.channel ? `Channel: ${oneLine(v.channel)} · ` : ''
  return `# ${oneLine(v.title) || 'YouTube video'}\n\n${channel}[Watch on YouTube](https://youtu.be/${v.id})\n\n${NOTES_HEADING}\n`
}

export interface NotesDocument {
  /** Everything before the notes (title, channel, link, your own text). */
  before: string
  notes: Note[]
  /** Everything after the notes section (a later heading and what follows it). */
  after: string
}

/** Reads a notes document. A document without a "## Notes" section gets one at the end. */
export function parseNotesDocument(markdown: string): NotesDocument {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex((l) => l.trim() === NOTES_HEADING)
  if (start === -1) return { before: `${markdown.trimEnd()}\n\n${NOTES_HEADING}\n`, notes: [], after: '' }
  let end = lines.findIndex((l, i) => i > start && /^#{1,2} /.test(l))
  if (end === -1) end = lines.length
  const body = lines.slice(start + 1, end)
  const notes: Note[] = []
  let current: { seconds: number; lines: string[] } | null = null
  for (const line of body) {
    const m = NOTE_START.exec(line)
    if (m) {
      if (current) notes.push({ seconds: current.seconds, text: current.lines.join('\n').trim() })
      current = { seconds: Number(m[2]), lines: [line.slice(m[0].length)] }
    } else if (current) {
      current.lines.push(line)
    }
  }
  if (current) notes.push({ seconds: current.seconds, text: current.lines.join('\n').trim() })
  return {
    before: `${lines.slice(0, start + 1).join('\n')}\n`,
    notes: sortNotes(notes),
    after: end < lines.length ? lines.slice(end).join('\n') : '',
  }
}

export function sortNotes(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => a.seconds - b.seconds)
}

export function renderNotesDocument(id: string, doc: NotesDocument): string {
  const notes = sortNotes(doc.notes).map((n) => noteMarkdown(id, n)).join('\n\n')
  const after = doc.after.trim() ? `\n\n${doc.after.trim()}\n` : '\n'
  return `${doc.before.trimEnd()}\n\n${notes}${notes ? '' : ''}${after}`.replace(/\n{3,}/g, '\n\n')
}

/** Where a frame image is embedded from a notes document in documents/YouTube/. */
export function frameMarkdown(assetPath: string, seconds: number): string {
  const name = assetPath.replace(/^documents\//, '')
  return `![Frame at ${formatTimestamp(seconds)}](../${encodeURI(name)})`
}

export interface Segment {
  start: number
  end: number
  text: string
}

/** The transcript around a moment (±window seconds), as "[mm:ss] text" lines. */
export function transcriptAround(segments: Segment[], seconds: number, window = 60): string {
  return segments
    .filter((s) => s.end > seconds - window && s.start < seconds + window)
    .map((s) => `[${formatTimestamp(s.start)}] ${oneLine(s.text)}`)
    .join('\n')
}

/** The whole transcript as "[mm:ss] text" lines. */
export function transcriptText(segments: Segment[]): string {
  return segments.map((s) => `[${formatTimestamp(s.start)}] ${oneLine(s.text)}`).join('\n')
}

function walk(node: unknown, visit: (key: string, value: unknown) => void, depth = 0): void {
  if (!node || typeof node !== 'object' || depth > 60) return
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    visit(k, v)
    walk(v, visit, depth + 1)
  }
}

function runsText(v: unknown): string {
  const o = v as { simpleText?: string; runs?: { text?: string }[] } | undefined
  return (o?.simpleText ?? o?.runs?.map((r) => r.text ?? '').join('') ?? '').trim()
}

/** "1:02:05" or "12:30" → seconds. */
export function parseClock(text: string): number | null {
  const parts = text.trim().split(':').map(Number)
  if (parts.length < 2 || parts.some((p) => !Number.isFinite(p))) return null
  return parts.reduce((acc, p) => acc * 60 + p, 0)
}

/** Segments from YouTube's transcript answer (both shapes it has used), or from its panel. */
export function segmentsFromRaw(raw: import('./youtubePage').TranscriptRaw): Segment[] {
  if (raw.kind === 'dom') {
    const segs = raw.rows
      .map((r) => ({ start: parseClock(r.time), text: r.text }))
      .filter((s): s is { start: number; text: string } => s.start !== null && Boolean(s.text))
    return segs.map((s, i) => ({ start: s.start, end: segs[i + 1]?.start ?? s.start + 5, text: s.text }))
  }
  if (raw.kind === 'captions') return captionSegments(raw.body)
  if (raw.kind !== 'innertube') return []
  const out: Segment[] = []
  walk(raw.json, (key, value) => {
    if (key === 'transcriptSegmentRenderer') {
      const v = value as { startMs?: string; endMs?: string; snippet?: unknown }
      const text = runsText(v.snippet)
      if (text) out.push({ start: Number(v.startMs ?? 0) / 1000, end: Number(v.endMs ?? 0) / 1000, text })
    } else if (key === 'transcriptCueRenderer') {
      const v = value as { startOffsetMs?: string; durationMs?: string; cue?: unknown }
      const text = runsText(v.cue)
      const start = Number(v.startOffsetMs ?? 0) / 1000
      if (text) out.push({ start, end: start + Number(v.durationMs ?? 0) / 1000, text })
    }
  })
  return out.sort((a, b) => a.start - b.start)
}

function decodeEntities(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** A caption track, as YouTube serves it: json3 (`events` with `segs`), or XML
 *  (`<text start dur>` in seconds, or srv3's `<p t d>` in milliseconds). */
export function captionSegments(body: string): Segment[] {
  const out: Segment[] = []
  const clean = (t: string) => t.replace(/\s+/g, ' ').trim()
  if (body.trim().startsWith('{')) {
    let json: { events?: { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string }[] }[] }
    try {
      json = JSON.parse(body)
    } catch {
      return []
    }
    for (const e of json.events ?? []) {
      const text = clean((e.segs ?? []).map((s) => s.utf8 ?? '').join(''))
      if (!text) continue
      const start = (e.tStartMs ?? 0) / 1000
      out.push({ start, end: start + (e.dDurationMs ?? 0) / 1000, text })
    }
  } else {
    const attr = (attrs: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1]
    for (const m of body.matchAll(/<(text|p)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
      const [, tag, attrs, inner] = m
      const text = clean(decodeEntities(inner))
      if (!text) continue
      const start = tag === 'text' ? Number(attr(attrs, 'start') ?? 0) : Number(attr(attrs, 't') ?? 0) / 1000
      const dur = tag === 'text' ? Number(attr(attrs, 'dur') ?? 0) : Number(attr(attrs, 'd') ?? 0) / 1000
      if (Number.isFinite(start)) out.push({ start, end: start + (Number.isFinite(dur) ? dur : 0), text })
    }
  }
  return out.sort((a, b) => a.start - b.start)
}
