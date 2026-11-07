import { describe, expect, it } from 'vitest'
import { documentPathFromAddress, findPassage, parsePassage, slugify } from './passage'

function page(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  return root
}

describe('parsePassage', () => {
  it('reads a heading, a quoted passage and a browser text fragment', () => {
    expect(parsePassage('')).toBeNull()
    expect(parsePassage('#')).toBeNull()
    expect(parsePassage('#scams-to-watch-for')).toEqual({ heading: 'scams-to-watch-for' })
    expect(parsePassage('#text=fake%20payment%20confirmations')).toEqual({ text: 'fake payment confirmations' })
    expect(parsePassage('#:~:text=fake%20payment')).toEqual({ text: 'fake payment' })
    expect(parsePassage('#:~:text=Be-,fake%20payment,requests')).toEqual({ text: 'fake payment' })
    expect(parsePassage('#Scams%20to%20watch%20for')).toEqual({ heading: 'Scams to watch for' })
  })
})

describe('slugify', () => {
  it('makes heading slugs like Markdown renderers do', () => {
    expect(slugify('Scams to watch for!')).toBe('scams-to-watch-for')
    expect(slugify('  Øl & Café – plan  ')).toBe('øl-cafe-plan')
  })
})

describe('findPassage', () => {
  const root = page(`
    <h1>Side Hustle Plan</h1>
    <h2>Scams to watch for</h2>
    <ul><li>Fake <strong>payment</strong>
      confirmations by email</li><li>Requests for SMS codes</li></ul>`)

  it('finds a heading by its slug or its text', () => {
    expect(findPassage(root, { heading: 'scams-to-watch-for' })?.toString()).toBe('Scams to watch for')
    expect(findPassage(root, { heading: 'Scams to watch for' })?.toString()).toBe('Scams to watch for')
  })

  it('finds a quote across formatting and line breaks, in any case', () => {
    expect(findPassage(root, { text: 'fake payment confirmations' })?.toString()).toBe('Fake payment\n      confirmations')
    expect(findPassage(root, { text: 'REQUESTS FOR SMS CODES' })?.toString()).toBe('Requests for SMS codes')
  })

  it('falls back to the first words of a reworded quote, and to words given as a slug', () => {
    expect(findPassage(root, { text: 'Requests for SMS codes or anything like that, never share them' })?.toString()).toBe(
      'Requests for SMS',
    )
    expect(findPassage(root, { heading: 'sms-codes' })?.toString()).toBe('SMS codes')
  })

  it('gives up on what is not there', () => {
    expect(findPassage(root, { text: 'tracked shipping' })).toBeNull()
    expect(findPassage(root, { heading: 'pricing' })).toBeNull()
  })
})

describe('documentPathFromAddress', () => {
  it('turns what an answer may write into the document path', () => {
    expect(documentPathFromAddress('tech-services/side-hustle-plan.md')).toBe('documents/tech-services/side-hustle-plan.md')
    expect(documentPathFromAddress('documents/tech-services/side-hustle-plan.md')).toBe('documents/tech-services/side-hustle-plan.md')
    expect(documentPathFromAddress('notes/Side%20Hustle')).toBe('documents/notes/Side Hustle.md')
  })
})
