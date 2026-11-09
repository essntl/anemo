import { describe, expect, it } from 'vitest'
import { classifyScriptError, looksLikePdf, toContext } from './pageContext'
import type { Extracted } from '@/inpage/extract'

const extracted = (over: Partial<Extracted> = {}): Extracted => ({
  url: 'https://news.example/a',
  title: 'Title',
  lang: 'en',
  byline: null,
  siteName: null,
  markdown: '# Heading\n\nBody text here.',
  text: 'Heading Body text here.',
  selection: '',
  selectionContext: '',
  method: 'readability',
  contentType: 'text/html',
  ...over,
})

describe('page context', () => {
  it('prefers the Markdown of the main content', () => {
    const c = toContext(extracted())
    expect(c).toMatchObject({ source: 'page', content: '# Heading\n\nBody text here.', truncated: false, wordCount: 5 })
  })

  it('uses the selection when asked, or when it was all there was', () => {
    expect(toContext(extracted({ selection: 'just this' }), true)).toMatchObject({ source: 'selection', content: 'just this' })
    expect(toContext(extracted({ markdown: null, text: 'sel', method: 'selection', selection: 'sel' }))).toMatchObject({ source: 'selection', content: 'sel' })
    expect(toContext(extracted({ markdown: null, text: 'Body only', method: 'body' }))).toMatchObject({ source: 'page', content: 'Body only' })
  })

  it('recognises PDFs by type or address', () => {
    expect(looksLikePdf('https://uni.example/paper.PDF')).toBe(true)
    expect(looksLikePdf('https://uni.example/view?id=3', 'application/pdf')).toBe(true)
    expect(looksLikePdf('https://uni.example/page.html')).toBe(false)
  })

  it('tells pages no extension may read from missing access', () => {
    expect(classifyScriptError('Cannot access a chrome:// URL')).toEqual({ reason: 'restricted' })
    expect(classifyScriptError('The extensions gallery cannot be scripted.')).toEqual({ reason: 'restricted' })
    expect(classifyScriptError('Cannot access contents of the page. Extension manifest must request permission to access the respective host.', 'https://news.example/a?b=1')).toEqual({ reason: 'no_access', origin: 'https://news.example' })
    expect(classifyScriptError('Frame with ID 0 was removed.')).toMatchObject({ reason: 'failed' })
  })
})
