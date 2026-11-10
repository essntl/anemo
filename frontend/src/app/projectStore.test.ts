import { describe, expect, it } from 'vitest'
import { inScope, type Scope, useProjectStore } from './projectStore'

const project = { kind: 'project', project: { id: 'p1' } } as Scope

describe('inScope', () => {
  it('Uncategorized holds only what is in no project', () => {
    const scope: Scope = { kind: 'uncategorized' }
    expect(inScope(scope, null)).toBe(true)
    expect(inScope(scope, undefined)).toBe(true)
    expect(inScope(scope, 'p1')).toBe(false)
  })

  it('a project holds only its own', () => {
    expect(inScope(project, 'p1')).toBe(true)
    expect(inScope(project, 'p2')).toBe(false)
    expect(inScope(project, null)).toBe(false)
  })

  it('All holds everything', () => {
    const scope: Scope = { kind: 'all' }
    expect(inScope(scope, null)).toBe(true)
    expect(inScope(scope, 'p1')).toBe(true)
  })
})

describe('the project store', () => {
  it('starts in Uncategorized', () => {
    expect(useProjectStore.getInitialState()).toMatchObject({ projectId: null, view: 'uncategorized' })
  })

  it('choosing a view leaves the project; leaving a project keeps the view', () => {
    useProjectStore.setState({ projectId: 'p1', view: 'all' })
    useProjectStore.getState().setProjectId(null)
    expect(useProjectStore.getState()).toMatchObject({ projectId: null, view: 'all' })
    useProjectStore.getState().setProjectId('p1')
    useProjectStore.getState().setView('uncategorized')
    expect(useProjectStore.getState()).toMatchObject({ projectId: null, view: 'uncategorized' })
  })
})
