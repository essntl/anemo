/**
 * The daily note's text: a Markdown document with one `- [ ] note` / `- [x] note`
 * line per note (see backend features/daily_notes). It can also be edited in the
 * document editor, by an agent or in Files, so everything that is not a note (the
 * heading, paragraphs, indented items, …) is kept exactly as it is: changes only
 * touch note lines.
 *
 * Every change is a function from the current text to the new one, so a change can
 * be applied again on top of a newer version when the file changed elsewhere.
 */

export interface Note {
  /** Position among the notes (0 = first). */
  index: number
  text: string
  done: boolean
}

/** A note: a top-level checklist item. Indented items belong to something else. */
const NOTE = /^([-*+]) \[( |x|X)\] (.*)$/

type Line = { note: true; bullet: string; done: boolean; text: string } | { note: false; raw: string }

function parseLines(content: string): Line[] {
  if (!content) return []
  const body = content.endsWith('\n') ? content.slice(0, -1) : content
  return body.split('\n').map((raw): Line => {
    const m = NOTE.exec(raw.replace(/\r$/, ''))
    return m ? { note: true, bullet: m[1], done: m[2] !== ' ', text: m[3].trim() } : { note: false, raw }
  })
}

function serialize(lines: Line[]): string {
  if (!lines.length) return ''
  return lines.map((l) => (l.note ? `${l.bullet} [${l.done ? 'x' : ' '}] ${l.text}`.trimEnd() : l.raw)).join('\n') + '\n'
}

/** The notes in the text, in order. */
export function parseNotes(content: string | null | undefined): Note[] {
  return parseLines(content ?? '')
    .filter((l): l is Extract<Line, { note: true }> => l.note)
    .map((l, index) => ({ index, text: l.text, done: l.done }))
}

/** One line of text: notes are single lines. */
export function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export type NoteChange = (content: string | null) => string

/** The text of a note that does not exist yet: the date as a heading, then the notes. */
export function startNote(heading: string): string {
  return `# ${heading}\n\n`
}

/** Add a note after the last one (or at the end when there is none yet). */
export function addNote(text: string, heading: string): NoteChange {
  return (content) => {
    const lines = parseLines(content || startNote(heading))
    const line: Line = { note: true, bullet: '-', done: false, text: cleanText(text) }
    let last = -1
    lines.forEach((l, i) => {
      if (l.note) last = i
    })
    if (last >= 0) lines.splice(last + 1, 0, line)
    else {
      // Keep a blank line between the text before and the first note.
      if (lines.length && !(lines.at(-1)!.note === false && (lines.at(-1) as { raw: string }).raw.trim() === '')) lines.push({ note: false, raw: '' })
      lines.push(line)
    }
    return serialize(lines)
  }
}

function changeNote(index: number, change: (line: Extract<Line, { note: true }>) => Line | null): NoteChange {
  return (content) => {
    const lines = parseLines(content ?? '')
    let n = -1
    const out: Line[] = []
    for (const l of lines) {
      if (l.note && ++n === index) {
        const next = change(l)
        if (next) out.push(next)
      } else out.push(l)
    }
    return serialize(out)
  }
}

export const toggleNote = (index: number, done: boolean): NoteChange => changeNote(index, (l) => ({ ...l, done }))
export const editNote = (index: number, text: string): NoteChange => changeNote(index, (l) => ({ ...l, text: cleanText(text) }))
export const removeNote = (index: number): NoteChange => changeNote(index, () => null)

/**
 * Put the notes in a new order: `order` lists the current positions in the order
 * wanted. The notes keep the lines they were on; only which note is on which of
 * those lines changes, so text between notes stays where it is.
 */
export function reorderNotes(order: number[]): NoteChange {
  return (content) => {
    const lines = parseLines(content ?? '')
    const notes = lines.filter((l): l is Extract<Line, { note: true }> => l.note)
    if (order.length !== notes.length || new Set(order).size !== notes.length || order.some((i) => !(i in notes))) {
      return serialize(lines) // made for another version of the note: leave it
    }
    let n = 0
    return serialize(lines.map((l) => (l.note ? notes[order[n++]] : l)))
  }
}

/** Move one note up (-1) or down (+1). */
export function moveNote(index: number, by: number, count: number): NoteChange | null {
  const to = index + by
  if (to < 0 || to >= count) return null
  const order = Array.from({ length: count }, (_, i) => i)
  order.splice(index, 1)
  order.splice(to, 0, index)
  return reorderNotes(order)
}

/** "2026-11-05" → the day before or after, as "YYYY-MM-DD" (dates without times, no time zones). */
export function shiftDay(day: string, by: number): string {
  const [y, m, d] = day.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d + by))
  return date.toISOString().slice(0, 10)
}

/** "Thu 5 Nov" for the widget's header. */
export function shortDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
}
