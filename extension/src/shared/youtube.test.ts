import { describe, expect, it } from 'vitest'
import {
  formatTimestamp,
  frameMarkdown,
  newNotesDocument,
  noteMarkdown,
  parseNotesDocument,
  parseVideoUrl,
  renderNotesDocument,
  timestampLink,
  transcriptAround,
} from './youtube'

const ID = 'dQw4w9WgXcQ'

describe('YouTube addresses', () => {
  it('finds the video in watch pages, playlists, youtu.be and live links', () => {
    expect(parseVideoUrl(`https://www.youtube.com/watch?v=${ID}`)).toEqual({ kind: 'video', id: ID, list: null })
    expect(parseVideoUrl(`https://www.youtube.com/watch?v=${ID}&list=PL123&index=4`)).toEqual({ kind: 'video', id: ID, list: 'PL123' })
    expect(parseVideoUrl(`https://youtu.be/${ID}?t=30`)).toEqual({ kind: 'video', id: ID, list: null })
    expect(parseVideoUrl(`https://m.youtube.com/watch?v=${ID}`)).toMatchObject({ id: ID })
    expect(parseVideoUrl(`https://www.youtube.com/live/${ID}`)).toMatchObject({ kind: 'video', id: ID })
  })

  it('recognises Shorts, and nothing else', () => {
    expect(parseVideoUrl(`https://www.youtube.com/shorts/${ID}`)).toEqual({ kind: 'short', id: ID })
    expect(parseVideoUrl('https://www.youtube.com/')).toBeNull()
    expect(parseVideoUrl('https://www.youtube.com/watch?v=short')).toBeNull()
    expect(parseVideoUrl(`https://evil.example/watch?v=${ID}`)).toBeNull()
    expect(parseVideoUrl('not a url')).toBeNull()
  })
})

describe('timestamps', () => {
  it('formats times and links', () => {
    expect(formatTimestamp(0)).toBe('00:00')
    expect(formatTimestamp(65.9)).toBe('01:05')
    expect(formatTimestamp(3725)).toBe('1:02:05')
    expect(timestampLink(ID, 65.9)).toBe(`https://youtu.be/${ID}?t=65`)
    expect(noteMarkdown(ID, { seconds: 65, text: ' **Key** idea ' })).toBe(`[01:05](https://youtu.be/${ID}?t=65) **Key** idea`)
  })
})

describe('the notes document', () => {
  const doc = newNotesDocument({ id: ID, title: 'Lecture 3: Thermodynamics', channel: 'MIT OpenCourseWare' })

  it('starts with the title, channel and link', () => {
    expect(doc).toBe(`# Lecture 3: Thermodynamics\n\nChannel: MIT OpenCourseWare · [Watch on YouTube](https://youtu.be/${ID})\n\n## Notes\n`)
  })

  it('round-trips notes in time order, multi-line notes included', () => {
    const parsed = parseNotesDocument(doc)
    parsed.notes.push({ seconds: 750, text: 'Second law.\nEntropy never decreases.' }, { seconds: 65, text: 'First law.' })
    const text = renderNotesDocument(ID, parsed)
    expect(text).toContain(`## Notes\n\n[01:05](https://youtu.be/${ID}?t=65) First law.\n\n[12:30](https://youtu.be/${ID}?t=750) Second law.\nEntropy never decreases.\n`)
    expect(parseNotesDocument(text).notes).toEqual([
      { seconds: 65, text: 'First law.' },
      { seconds: 750, text: 'Second law.\nEntropy never decreases.' },
    ])
  })

  it('keeps what you wrote around the notes', () => {
    const text = `# T\n\nMy intro.\n\n## Notes\n\n[00:10](https://youtu.be/${ID}?t=10) a\n\n## Summary\n\nWritten in Anemo.\n`
    const parsed = parseNotesDocument(text)
    expect(parsed.notes).toEqual([{ seconds: 10, text: 'a' }])
    parsed.notes.push({ seconds: 5, text: 'b' })
    const out = renderNotesDocument(ID, parsed)
    expect(out).toContain('My intro.')
    expect(out).toContain(`[00:05](https://youtu.be/${ID}?t=5) b\n\n[00:10](https://youtu.be/${ID}?t=10) a\n\n## Summary\n\nWritten in Anemo.\n`)
  })

  it('adds the section to a document that has none', () => {
    const parsed = parseNotesDocument('# Only a title\n')
    expect(parsed.before).toBe('# Only a title\n\n## Notes\n')
  })

  it('embeds a frame relative to the document', () => {
    expect(frameMarkdown('documents/_assets/frame 1.jpg', 65)).toBe('![Frame at 01:05](../_assets/frame%201.jpg)')
  })
})

describe('transcript', () => {
  it('takes the part around a moment', () => {
    const segs = [0, 30, 60, 90, 120, 150, 200].map((s) => ({ start: s, end: s + 30, text: `at ${s}` }))
    expect(transcriptAround(segs, 120, 60).split('\n')).toEqual(['[01:00] at 60', '[01:30] at 90', '[02:00] at 120', '[02:30] at 150'])
  })
})

describe('reading YouTube’s transcript', () => {
  it('reads the current answer shape', async () => {
    const { segmentsFromRaw } = await import('./youtube')
    const json = { actions: [{ updateEngagementPanelAction: { content: { transcriptRenderer: { content: { transcriptSearchPanelRenderer: { body: { transcriptSegmentListRenderer: { initialSegments: [
      { transcriptSegmentRenderer: { startMs: '0', endMs: '4200', snippet: { runs: [{ text: 'Velkommen til ' }, { text: 'forelesningen' }] } } },
      { transcriptSectionHeaderRenderer: { snippet: { simpleText: 'Chapter 1' } } },
      { transcriptSegmentRenderer: { startMs: '4200', endMs: '9000', snippet: { simpleText: 'om termodynamikk.' } } },
    ] } } } } } } } }] }
    expect(segmentsFromRaw({ kind: 'innertube', json })).toEqual([
      { start: 0, end: 4.2, text: 'Velkommen til forelesningen' },
      { start: 4.2, end: 9, text: 'om termodynamikk.' },
    ])
  })

  it('reads the older shape and the transcript panel', async () => {
    const { segmentsFromRaw } = await import('./youtube')
    const json = { cueGroups: [{ transcriptCueGroupRenderer: { cues: [{ transcriptCueRenderer: { cue: { simpleText: 'Hallo' }, startOffsetMs: '1500', durationMs: '2000' } }] } }] }
    expect(segmentsFromRaw({ kind: 'innertube', json })).toEqual([{ start: 1.5, end: 3.5, text: 'Hallo' }])
    expect(segmentsFromRaw({ kind: 'dom', rows: [{ time: '0:05', text: 'a' }, { time: '1:02:10', text: 'b' }, { time: '', text: 'c' }] })).toEqual([
      { start: 5, end: 3730, text: 'a' },
      { start: 3730, end: 3735, text: 'b' },
    ])
    expect(segmentsFromRaw({ kind: 'none', reason: 'x' })).toEqual([])
  })
})
