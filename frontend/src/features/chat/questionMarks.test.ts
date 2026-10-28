import { describe, expect, it } from 'vitest'
import { splitAtQuestions } from './questionMarks'

const mark = (at: number, answer: string | null = 'Yes') => ({ at, question: 'Ok?', answer })

describe('splitAtQuestions', () => {
  it('leaves an answer without questions as it is', () => {
    expect(splitAtQuestions('Hello', [])).toEqual([{ kind: 'text', text: 'Hello' }])
  })

  it('puts the question between the text before and after it', () => {
    const text = 'Let me look.\n\nBooked it.'
    expect(splitAtQuestions(text, [mark('Let me look.'.length)])).toEqual([
      { kind: 'text', text: 'Let me look.' },
      { kind: 'question', mark: mark(12) },
      { kind: 'text', text: 'Booked it.' },
    ])
  })

  it('cuts at the nearest paragraph break when the offset is a little off', () => {
    const text = 'One.\n\nTwo [1](https://x.y).\n\nThree.'
    const parts = splitAtQuestions(text, [mark(text.indexOf('Three') - 6)])
    expect(parts.map((p) => (p.kind === 'text' ? p.text : '?'))).toEqual(['One.\n\nTwo [1](https://x.y).', '?', 'Three.'])
  })

  it('shows a question asked before any text first, and several in order', () => {
    const parts = splitAtQuestions('A\n\nB', [mark(1, null), mark(0)])
    expect(parts.map((p) => (p.kind === 'text' ? p.text : `?${p.mark.at}`))).toEqual(['?0', 'A', '?1', 'B'])
  })

  it('keeps a question asked at the very end', () => {
    const parts = splitAtQuestions('Asked.', [mark(6)])
    expect(parts.map((p) => p.kind)).toEqual(['text', 'question'])
  })
})
