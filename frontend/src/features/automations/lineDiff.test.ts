import { describe, expect, it } from 'vitest'
import { lineDiff, listDiff } from './lineDiff'

describe('lineDiff', () => {
  it('marks kept, removed and added lines in order', () => {
    expect(lineDiff('a\nb\nc', 'a\nx\nc\nd')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'x' },
      { kind: 'same', text: 'c' },
      { kind: 'added', text: 'd' },
    ])
  })

  it('shows a new script as all added', () => {
    expect(lineDiff('', 'one\ntwo').filter((l) => l.kind === 'added').map((l) => l.text)).toEqual(['one', 'two'])
  })

  it('finds nothing in identical texts', () => {
    expect(lineDiff('x\ny', 'x\ny').every((l) => l.kind === 'same')).toBe(true)
  })
})

describe('listDiff', () => {
  it('says what a change adds and takes out', () => {
    expect(listDiff(['create_task', 'list_tasks'], ['create_task', 'http_request'])).toEqual({
      added: ['http_request'],
      removed: ['list_tasks'],
      kept: ['create_task'],
    })
  })
})
