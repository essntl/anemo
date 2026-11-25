import { describe, expect, it } from 'vitest'
import { type ViewRow, withProperty } from './api'

const row = (id: string, properties: Record<string, unknown>) => ({ id, properties }) as ViewRow

describe('a property set before the server answers (a card dragged to another column)', () => {
  it('changes only that row, and an empty value takes the property off', () => {
    const data = { rows: [row('a', { client: 'acme' }), row('b', { client: 'acme' })], truncated: false }
    const moved = withProperty(data, 'a', 'client', 'ludmyla-doula')
    expect(moved.rows.map((r) => r.properties)).toEqual([{ client: 'ludmyla-doula' }, { client: 'acme' }])
    expect(withProperty(data, 'b', 'client', '').rows[1].properties).toEqual({})
    expect(data.rows[0].properties).toEqual({ client: 'acme' }) // the cached data is not changed in place
  })
})
