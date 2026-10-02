import { describe, expect, it } from 'vitest'
import { documentLink, isAppLink, taskLink } from './appLinks'

describe('links inside the app', () => {
  it('point to the page of a document or a task', () => {
    expect(documentLink('abc')).toBe('/documents/abc')
    expect(taskLink('abc')).toBe('/tasks?task=abc')
  })

  it('are told apart from links to other sites', () => {
    expect(isAppLink('/documents/abc')).toBe(true)
    expect(isAppLink('?doc=2')).toBe(true)
    expect(isAppLink('https://example.com/documents/abc')).toBe(false)
    expect(isAppLink('//example.com')).toBe(false)
    expect(isAppLink('mailto:someone@example.com')).toBe(false)
  })
})
