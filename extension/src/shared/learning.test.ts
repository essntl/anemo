import { describe, expect, it } from 'vitest'
import { discussDraft, PROMPTS } from './learning'

describe('learning actions', () => {
  it('quotes the selection for "Discuss in chat", line by line', () => {
    expect(discussDraft('  first line\nsecond line ')).toBe('> first line\n> second line\n\n')
    expect(discussDraft('   ')).toBe('')
  })

  it('asks for what was decided: TL;DR + key points; 5 questions, one at a time, graded', () => {
    expect(PROMPTS.summarize).toMatch(/TL;DR/)
    expect(PROMPTS.summarize).toMatch(/key points/)
    expect(PROMPTS.quiz).toMatch(/5 questions in total, one at a time/)
    expect(PROMPTS.quiz).toMatch(/multiple-choice and short-answer/)
    expect(PROMPTS.quiz).toMatch(/grade it/)
  })
})
