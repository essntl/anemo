import { emptySketch, type SketchData } from '../model'
import { canRedo, canUndo, record, redo, startHistory, undo } from './history'

const version = (n: number): SketchData => ({ ...emptySketch(), pages: n })

describe('undo history', () => {
  it('undoes and redoes in order', () => {
    let h = startHistory(version(1))
    h = record(h, version(2))
    h = record(h, version(3))
    expect(canUndo(h)).toBe(true)
    h = undo(h)
    expect(h.present.pages).toBe(2)
    h = undo(h)
    expect(h.present.pages).toBe(1)
    expect(canUndo(h)).toBe(false)
    expect(undo(h)).toBe(h)
    h = redo(h)
    expect(h.present.pages).toBe(2)
    expect(canRedo(h)).toBe(true)
  })

  it('forgets what was undone once something new is done', () => {
    let h = record(startHistory(version(1)), version(2))
    h = undo(h)
    h = record(h, version(5))
    expect(canRedo(h)).toBe(false)
    expect(redo(h)).toBe(h)
    expect(undo(h).present.pages).toBe(1)
  })

  it('keeps at most the limit of steps', () => {
    let h = startHistory(version(1))
    for (let i = 2; i <= 10; i++) h = record(h, version(i), 3)
    expect(h.past.map((d) => d.pages)).toEqual([7, 8, 9])
  })

  it('ignores recording the same drawing', () => {
    const h = startHistory(version(1))
    expect(record(h, h.present)).toBe(h)
  })
})
