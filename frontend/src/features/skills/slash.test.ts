import { describe, expect, it } from 'vitest'
import { matchSkills, slashQuery, typedCommand } from './slash'

const skills = [
  { id: '1', slug: 'study', name: 'Study', description: 'Learn a concept step by step.' },
  { id: '2', slug: 'fact-check', name: 'Fact check', description: 'Check a claim.' },
  { id: '3', slug: 'plan', name: 'Plan', description: 'Turn an idea into steps.' },
  { id: '4', slug: 'review', name: 'Review', description: 'Honest feedback on a plan.' },
]

describe('slash commands', () => {
  it('opens only while the message is a bare command', () => {
    expect(slashQuery('/')).toBe('')
    expect(slashQuery('/St')).toBe('st')
    expect(slashQuery('/fact-c')).toBe('fact-c')
    expect(slashQuery('/study what')).toBeNull()
    expect(slashQuery('hello /study')).toBeNull()
    expect(slashQuery('')).toBeNull()
  })

  it('ranks commands that start with the query first', () => {
    expect(matchSkills(skills, '').map((s) => s.slug)).toEqual(['fact-check', 'plan', 'review', 'study'])
    expect(matchSkills(skills, 'stu').map((s) => s.slug)).toEqual(['study'])
    // "plan" is in the review skill's description: it comes after the command itself.
    expect(matchSkills(skills, 'plan').map((s) => s.slug)).toEqual(['plan', 'review'])
    expect(matchSkills(skills, 'check').map((s) => s.slug)).toEqual(['fact-check'])
    expect(matchSkills(skills, 'zzz')).toEqual([])
  })

  it('turns a typed command into the skill and the rest of the text', () => {
    expect(typedCommand(skills, '/study what are objects')).toEqual({ skill: skills[0], rest: 'what are objects' })
    expect(typedCommand(skills, '/Plan ')).toEqual({ skill: skills[2], rest: '' })
    expect(typedCommand(skills, '/study')).toBeNull()
    expect(typedCommand(skills, '/unknown thing')).toBeNull()
    expect(typedCommand(skills, 'see /study x')).toBeNull()
  })
})
