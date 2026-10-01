import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { daysIn, rangeFor } from '@/features/usage/ranges'
import { Highlighted } from './Highlighted'
import { matchingPages } from './pages'

describe('search box pages', () => {
  it('finds pages by name or keyword, every word must match', () => {
    expect(matchingPages('cal').map((p) => p.to)).toEqual(['/calendar'])
    expect(matchingPages('todo').map((p) => p.to)).toEqual(['/tasks'])
    expect(matchingPages('settings mcp').map((p) => p.to)).toEqual(['/settings/mcp'])
    expect(matchingPages('settings zeppelin')).toEqual([])
    expect(matchingPages('').length).toBeGreaterThan(10) // no query: everything
  })
})

describe('search snippets', () => {
  it('highlights the words the server marked', () => {
    const { container } = render(<Highlighted text="tell me about «otters» and «seals»." />)
    expect([...container.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['otters', 'seals'])
    expect(container.textContent).toBe('tell me about otters and seals.')
  })

  it('shows text without marks as it is', () => {
    const { container } = render(<Highlighted text="plain text" />)
    expect(container.querySelector('mark')).toBeNull()
    expect(container.textContent).toBe('plain text')
  })
})

describe('usage periods', () => {
  const now = new Date(2026, 9, 15, 14, 30) // 15 October 2026, local time

  it('starts and ends periods at local midnight', () => {
    const today = rangeFor('today', now)
    expect(new Date(today.start!)).toEqual(new Date(2026, 9, 15))
    expect(new Date(today.end!)).toEqual(new Date(2026, 9, 16))
    expect(new Date(rangeFor('7d', now).start!)).toEqual(new Date(2026, 9, 9))
    expect(new Date(rangeFor('month', now).start!)).toEqual(new Date(2026, 9, 1))
    expect(rangeFor('all', now)).toEqual({ start: null, end: null })
  })

  it('lists every day of a period for the chart', () => {
    expect(daysIn(rangeFor('7d', now))).toEqual([
      '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15',
    ])
    expect(daysIn(rangeFor('30d', now))).toHaveLength(30)
    expect(daysIn(rangeFor('all', now))).toBeNull()
  })
})
