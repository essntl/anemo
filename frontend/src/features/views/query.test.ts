import { describe, expect, it } from 'vitest'
import type { Project } from '@/features/tasks/api'
import type { ViewQuery } from './api'
import { groupRows, queryText, sortRows, tableColumns } from './query'

const q = (over: Partial<ViewQuery>): ViewQuery => ({
  types: ['document'], text: null, folder: null, project_id: null, properties: {}, updated_after: null,
  updated_before: null, include_archived: false, sort: [], group_by: null, columns: [], ...over,
})
const projects = [{ id: 'p1', slug: 'tech-services', name: 'Tech Services' }] as Project[]
const row = (title: string, properties: Record<string, unknown>, updated_at = '2026-11-01T00:00:00Z') => ({ title, properties, updated_at })

describe('a view query as search text', () => {
  it('writes filters as key:value, the project and folder as in:, then the words', () => {
    expect(queryText(q({ properties: { client: 'ludmyla-doula', tags: { has: 'legal' } }, project_id: 'p1', text: 'price' }), projects))
      .toBe('client:ludmyla-doula tags:legal in:tech-services price')
    expect(queryText(q({ folder: 'clients/two words' }), projects)).toBe('in:"clients/two words"')
    expect(queryText(q({}), projects)).toBe('')
  })
  it('says when the text cannot express the query', () => {
    expect(queryText(q({ properties: { type: { missing: true } } }), projects)).toBeNull()
    expect(queryText(q({ properties: { status: { in: ['draft', 'active'] } } }), projects)).toBeNull()
    expect(queryText(q({ project_id: 'gone' }), projects)).toBeNull()
  })
})

describe('table and board helpers', () => {
  const rows = [row('b', { client: 'acme', tags: ['x', 'y'] }), row('a', {}), row('c', { client: 'zed' }, '2026-12-01T00:00:00Z')]
  it('shows the asked columns, else every property the rows have, in the definitions order', () => {
    expect(tableColumns(q({ columns: ['status'] }), rows, ['client', 'tags'])).toEqual(['status'])
    expect(tableColumns(q({}), rows, ['tags', 'client', 'type'])).toEqual(['tags', 'client'])
  })
  it('sorts by a column, rows without a value last', () => {
    expect(sortRows(rows, 'client', false).map((r) => r.title)).toEqual(['b', 'c', 'a'])
    expect(sortRows(rows, 'client', true).map((r) => r.title)).toEqual(['c', 'b', 'a'])
    expect(sortRows(rows, 'title', false).map((r) => r.title)).toEqual(['a', 'b', 'c'])
    expect(sortRows(rows, 'updated_at', true)[0].title).toBe('c')
  })
  it('groups by a value, a list counting in each of its values', () => {
    const groups = groupRows(rows, 'tags', ['x', 'y', 'z'])
    expect(groups.map(([name, list]) => [name, list.map((r) => r.title)])).toEqual([
      ['x', ['b']], ['y', ['b']], ['z', []], ['', ['a', 'c']],
    ])
  })
})
