import { describe, expect, it } from 'vitest'
import type { Schemas } from '@/api/client'
import { initials, laneColor, nameColor, shortHash } from './gitFormat'
import { refIndex, refPills } from './gitRefs'

const branch = (over: Partial<Schemas['GitBranch']> & { name: string }): Schemas['GitBranch'] => ({
  commit: 'c'.repeat(40), remote: false, upstream: null, ahead: 0, behind: 0, current: false, pullRequest: null, ...over,
})

const pr = { number: 90, title: 'Git view', headRef: 'feat/git', url: 'https://github.com/o/r/pull/90', draft: false }

const index = refIndex({
  remotes: ['origin'],
  branches: [
    branch({ name: 'main', upstream: 'origin/main', current: true, ahead: 2, behind: 5 }),
    branch({ name: 'feat/git', upstream: 'origin/feat/git' }),
    branch({ name: 'origin/main', remote: true }),
    branch({ name: 'origin/feat/git', remote: true, pullRequest: pr }),
    branch({ name: 'origin/old', remote: true }),
    branch({ name: 'scratch' }),
  ],
})

describe('refPills', () => {
  it('orders HEAD, local branches (current first), remote branches, tags', () => {
    const pills = refPills(['tag: v1.0', 'origin/old', 'scratch', 'HEAD', 'main'], index)
    expect(pills.map((p) => p.kind)).toEqual(['head', 'branch', 'branch', 'remote', 'tag'])
    expect(pills.map((p) => (p.kind === 'head' ? 'HEAD' : p.name))).toEqual(['HEAD', 'main', 'scratch', 'origin/old', 'v1.0'])
  })

  it('folds a branch and its upstream on the same commit into one synced pill', () => {
    const pills = refPills(['main', 'origin/main'], index)
    expect(pills).toHaveLength(1)
    expect(pills[0]).toMatchObject({ kind: 'branch', name: 'main', synced: true, upstream: 'origin/main' })
  })

  it('keeps the upstream as a pill of its own when it is elsewhere, and carries ahead/behind', () => {
    expect(refPills(['main'], index)[0]).toMatchObject({ synced: false, ahead: 2, behind: 5, current: true })
    expect(refPills(['origin/main'], index)).toEqual([{ kind: 'remote', name: 'origin/main', pullRequest: null }])
  })

  it('puts the pull request on its branch, and on the synced pill of its local branch', () => {
    expect(refPills(['origin/feat/git'], index)[0]).toMatchObject({ kind: 'remote', pullRequest: pr })
    expect(refPills(['feat/git', 'origin/feat/git'], index)).toEqual([
      expect.objectContaining({ kind: 'branch', name: 'feat/git', synced: true, pullRequest: pr }),
    ])
    expect(refPills(['feat/git'], index)[0]).toMatchObject({ pullRequest: null })
  })

  it('reads "HEAD -> main" and leaves out a remote’s HEAD', () => {
    const pills = refPills(['HEAD -> main', 'origin/HEAD', 'origin/main'], index)
    expect(pills.map((p) => p.kind)).toEqual(['head', 'branch'])
  })

  it('marks a detached HEAD', () => {
    expect(refPills(['HEAD'], index, true)).toEqual([{ kind: 'head', detached: true }])
  })

  it('tells remote branches it doesn’t know by the remote’s name', () => {
    expect(refPills(['origin/unknown', 'unknown'], index).map((p) => p.kind)).toEqual(['branch', 'remote'])
  })

  it('has no pills for no refs', () => {
    expect(refPills([], index)).toEqual([])
  })
})

describe('git formatting', () => {
  it('shortens hashes and finds initials', () => {
    expect(shortHash('0123456789abcdef')).toBe('0123456')
    expect(initials('Artem Kotov')).toBe('AK')
    expect(initials('claude')).toBe('CL')
    expect(initials('ann-marie de la cruz')).toBe('AC')
    expect(initials('  ')).toBe('?')
  })

  it('gives a name the same colour every time, from the theme’s lane colours', () => {
    expect(nameColor('Artem Kotov')).toBe(nameColor('artem kotov '))
    expect(nameColor('x')).toBeGreaterThanOrEqual(0)
    expect(laneColor(0)).toBe('var(--git-lane-1)')
    expect(laneColor(9)).toBe('var(--git-lane-2)')
  })
})
