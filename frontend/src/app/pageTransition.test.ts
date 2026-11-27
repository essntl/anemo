import { describe, expect, it } from 'vitest'
import { sectionOf, staysOnPage } from './pageTransition'

describe('which navigations cross-fade the page', () => {
  it('names the page by the first part of the path', () => {
    expect(sectionOf('/code/abc')).toBe('code')
    expect(sectionOf('/settings/pages?x=1')).toBe('settings')
    expect(sectionOf('/')).toBe('')
  })

  it('another item of the same page, a tab or a filter: no page cross-fade', () => {
    expect(staysOnPage('/code/b', '/code/a')).toBe(true)
    expect(staysOnPage('/code', '/code/a')).toBe(true)
    expect(staysOnPage('/c/2', '/c/1')).toBe(true)
    expect(staysOnPage('/settings/pages', '/settings/general')).toBe(true)
    expect(staysOnPage('?tab=git', '/code/a')).toBe(true)
    expect(staysOnPage({ pathname: '/documents/x', search: '?q=1' }, '/documents/y')).toBe(true)
    expect(staysOnPage(null, '/tasks')).toBe(true)
  })

  it('another page: the page cross-fades', () => {
    expect(staysOnPage('/tasks', '/code/a')).toBe(false)
    expect(staysOnPage('/c/1', '/')).toBe(false)
    expect(staysOnPage('/', '/c/1')).toBe(false)
    expect(staysOnPage('/settings', '/documents')).toBe(false)
  })
})
