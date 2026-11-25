import { describe, expect, it } from 'vitest'
import { createBody, describeFilter, filterOf, formFrom, toLocalInput } from './triggerForm'

const type = {
  type: 'task.created', label: 'Task created', description: '',
  fields: [{ name: 'tags', label: 'Tag', kind: 'tags', choices: [] }, { name: 'title', label: 'Title', kind: 'text', choices: [] }],
}

describe('the trigger form', () => {
  it('turns what was typed into a filter: commas for several values, empty for any', () => {
    const form = { ...formFrom(null), filter: { tags: ' urgent ,home', title: '', other: 'x' } }
    expect(filterOf(form, type)).toEqual({ tags: ['urgent', 'home'] })
    expect(filterOf({ ...form, filter: { title: 'Milk' } }, type)).toEqual({ title: 'Milk' })
  })

  it('reads a saved trigger back into the form', () => {
    const form = formFrom({
      event_type: 'task.created', filter: { tags: ['a', 'b'], title: 'x' }, debounce_s: 30, max_per_hour: 5, once: true,
      expires_at: null, enabled: false, note: 'n',
    } as never)
    expect(form).toMatchObject({ filter: { tags: 'a, b', title: 'x' }, debounceS: 30, maxPerHour: 5, once: true, enabled: false })
    expect(describeFilter({ tags: ['a', 'b'], title: 'x' })).toBe('tags: a, b · title: x')
  })

  it('keeps the expiry in this browser’s time zone', () => {
    const local = toLocalInput('2026-11-25T10:30:00Z')
    expect(local).toMatch(/^2026-11-2\dT\d\d:30$/)
    const body = createBody('a1', { ...formFrom(null), expires: local }, type)
    expect(body.expires_at).toBe('2026-11-25T10:30:00.000Z')
  })
})
