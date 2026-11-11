import { describe, expect, it } from 'vitest'
import { setLocaleForTest } from '@/lib/i18n'
import { localSkills, matchSkills, slashQuery, typedCommand } from './slash'

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

describe('slash commands in other languages', () => {
  const builtin = [
    { id: '1', slug: 'study', name: 'Study', description: 'Learn.', hint: 'Learn a new concept', builtin: true },
    { id: '3', slug: 'plan', name: 'Plan', description: 'Steps.', hint: 'Plan a project, task or idea', builtin: true },
    // Edited by the user: their words stay.
    { id: '4', slug: 'review', name: 'Критика', description: 'Feedback.', hint: 'Моя підказка', builtin: true },
    // The user's own skill, named in Ukrainian (its slug is whatever the server made of it).
    { id: '9', slug: 'skill-9', name: 'Лист клієнту', description: 'Написати лист.' },
  ]
  const uk = {
    'study##command': 'вивчити', 'plan##command': 'план', 'review##command': 'рецензія',
    'Study##skill': 'Вивчення', 'Plan##skill': 'План', 'Learn a new concept': 'Розібратися в новій темі',
  }
  afterEach(() => setLocaleForTest('en'))

  it('leaves the skills as they are in English', () => {
    const [study] = localSkills(builtin)
    expect(study).toMatchObject({ command: 'study', name: 'Study', hint: 'Learn a new concept' })
  })

  it('gives built-in skills a command, name and hint in the language', () => {
    setLocaleForTest('uk', uk)
    const [study, plan, review, own] = localSkills(builtin)
    expect(study).toMatchObject({ command: 'вивчити', name: 'Вивчення', hint: 'Розібратися в новій темі' })
    expect(plan).toMatchObject({ command: 'план', name: 'План' })
    expect(review).toMatchObject({ command: 'рецензія', name: 'Критика', hint: 'Моя підказка' })
    expect(own).toBe(builtin[3])
  })

  it('opens the menu for letters of any alphabet', () => {
    expect(slashQuery('/Пл')).toBe('пл')
    expect(slashQuery('/план що робити')).toBeNull()
  })

  it('finds and calls a skill by its translated command, its slug, or its own name', () => {
    setLocaleForTest('uk', uk)
    const skills = localSkills(builtin)
    expect(matchSkills(skills, 'пл').map((s) => s.slug)).toEqual(['plan'])
    expect(matchSkills(skills, 'pl').map((s) => s.slug)).toEqual(['plan'])
    expect(matchSkills(skills, 'лист').map((s) => s.slug)).toEqual(['skill-9'])
    expect(typedCommand(skills, '/План відпустка в горах')).toEqual({ skill: skills[1], rest: 'відпустка в горах' })
    expect(typedCommand(skills, '/plan trip')?.skill.slug).toBe('plan')
    expect(typedCommand(skills, '/лист-клієнту про затримку')).toEqual({ skill: skills[3], rest: 'про затримку' })
    expect(typedCommand(skills, '/невідоме щось')).toBeNull()
  })
})
