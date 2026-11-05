import { describe, expect, it } from 'vitest'
import { addNote, editNote, moveNote, parseNotes, removeNote, reorderNotes, shiftDay, startNote, toggleNote } from './dailyNote'

const H = 'Thursday, 5 November 2026'

describe('daily note text', () => {
  it('reads notes from plain Markdown and leaves other lines alone', () => {
    const text = '# Day\n\nIntro text.\n\n- [ ] call Sam\n- [x] pay rent\n  - [ ] nested belongs to something else\n* [X] star\n'
    expect(parseNotes(text)).toEqual([
      { index: 0, text: 'call Sam', done: false },
      { index: 1, text: 'pay rent', done: true },
      { index: 2, text: 'star', done: true },
    ])
    expect(parseNotes(null)).toEqual([])
  })

  it('starts a new note with the date as a heading', () => {
    expect(addNote('call Sam', H)(null)).toBe(`# ${H}\n\n- [ ] call Sam\n`)
    expect(addNote('  two\nlines  ', H)('')).toBe(`${startNote(H)}- [ ] two lines\n`)
  })

  it('adds after the last note, keeping text written around them', () => {
    const text = '# Day\n\n- [ ] a\n- [ ] b\n\nA paragraph after.\n'
    expect(addNote('c', H)(text)).toBe('# Day\n\n- [ ] a\n- [ ] b\n- [ ] c\n\nA paragraph after.\n')
    // No notes yet, but other text: a blank line before the first note.
    expect(addNote('first', H)('# Day\nsome text')).toBe('# Day\nsome text\n\n- [ ] first\n')
  })

  it('ticks, edits and removes one note by position', () => {
    const text = '# Day\n\n- [ ] a\n\nmiddle\n\n+ [x] b\n'
    expect(toggleNote(1, false)(text)).toBe('# Day\n\n- [ ] a\n\nmiddle\n\n+ [ ] b\n')
    expect(toggleNote(0, true)(text)).toBe('# Day\n\n- [x] a\n\nmiddle\n\n+ [x] b\n')
    expect(editNote(0, ' A  again ')(text)).toBe('# Day\n\n- [ ] A again\n\nmiddle\n\n+ [x] b\n')
    expect(removeNote(0)(text)).toBe('# Day\n\n\nmiddle\n\n+ [x] b\n')
    expect(removeNote(5)(text)).toBe(text) // gone already: nothing changes
  })

  it('reorders notes in their own lines', () => {
    const text = '# Day\n\n- [ ] a\n- [x] b\ntext\n- [ ] c\n'
    expect(reorderNotes([2, 0, 1])(text)).toBe('# Day\n\n- [ ] c\n- [ ] a\ntext\n- [x] b\n')
    expect(reorderNotes([0, 1])(text)).toBe(text) // made for another version
    expect(moveNote(0, 1, 3)!(text)).toBe('# Day\n\n- [x] b\n- [ ] a\ntext\n- [ ] c\n')
    expect(moveNote(0, -1, 3)).toBeNull()
    expect(moveNote(2, 1, 3)).toBeNull()
  })

  it('changes apply again on top of a newer version', () => {
    const mine = addNote('mine', H)
    const theirs = '# Day\n\n- [ ] theirs\n'
    expect(mine(theirs)).toBe('# Day\n\n- [ ] theirs\n- [ ] mine\n')
  })

  it('steps through days without time zones getting in the way', () => {
    expect(shiftDay('2026-11-05', -1)).toBe('2026-11-04')
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28')
    expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01')
    expect(shiftDay('2026-03-29', 1)).toBe('2026-03-30') // a clock change in Europe
  })
})
