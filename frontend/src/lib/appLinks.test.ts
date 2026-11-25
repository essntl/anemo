import { describe, expect, it } from 'vitest'
import { chatLink, documentLink, embeddedSketchId, eventLink, isAppLink, sketchIdOfPreview, sketchPreviewUrl, taskLink } from './appLinks'

describe('links inside the app', () => {
  it('point to the page of a document, task, event or chat', () => {
    expect(documentLink('abc')).toBe('/documents/abc')
    expect(taskLink('abc')).toBe('/tasks?task=abc')
    expect(eventLink('abc')).toBe('/calendar?event=abc')
    expect(chatLink('abc')).toBe('/c/abc')
  })

  it('are told apart from links to other sites', () => {
    expect(isAppLink('/documents/abc')).toBe(true)
    expect(isAppLink('?doc=2')).toBe(true)
    expect(isAppLink('/\\evil.example/path')).toBe(false) // a browser goes to another site
    expect(isAppLink('https://example.com/documents/abc')).toBe(false)
    expect(isAppLink('//example.com')).toBe(false)
    expect(isAppLink('mailto:someone@example.com')).toBe(false)
  })
})

describe('embedded sketches', () => {
  const id = '0193a2b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b'

  it('are images whose address is the sketch’s page', () => {
    expect(embeddedSketchId(`/documents/${id}`)).toBe(id)
    expect(embeddedSketchId('/documents/not-an-id')).toBeNull()
    expect(embeddedSketchId(`/documents/${id}/more`)).toBeNull()
    expect(embeddedSketchId(`https://evil.example/documents/${id}`)).toBeNull()
    expect(embeddedSketchId(undefined)).toBeNull()
  })

  it('show the image the app serves, and are told by it', () => {
    expect(sketchPreviewUrl(id)).toBe(`/api/documents/${id}/sketch/preview`)
    expect(sketchIdOfPreview(sketchPreviewUrl(id))).toBe(id)
    expect(sketchIdOfPreview('/api/files/download?path=a.png')).toBeNull()
  })
})
