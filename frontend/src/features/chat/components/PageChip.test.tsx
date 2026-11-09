import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({
  usePageContent: (_c: string, _m: string, enabled: boolean) =>
    enabled ? { isPending: false, isError: false, data: { content: 'Line one\n<img src=x onerror=alert(1)> stays text' } } : { isPending: true },
}))

const { PageChip } = await import('./PageChip')

const page = { url: 'https://news.example/a', title: 'An article', source: 'page', word_count: 1234, truncated: true }

describe('the page chip', () => {
  it('shows title, site, words and that it was shortened', () => {
    render(<PageChip page={page} conversationId="c" messageId="m" />)
    expect(screen.getByText('An article')).toBeInTheDocument()
    expect(screen.getByText(/news\.example · 1,234 words · shortened/)).toBeInTheDocument()
  })

  it('opens the attached text as plain text, never as HTML', async () => {
    const { baseElement } = render(<PageChip page={page} conversationId="c" messageId="m" />)
    await userEvent.click(screen.getByRole('button', { name: /An article/ }))
    expect(await screen.findByText(/stays text/)).toBeInTheDocument()
    expect(baseElement.querySelector('img[src="x"]')).toBeNull()
    expect(screen.getByRole('link', { name: /Open the page/ })).toHaveAttribute('href', 'https://news.example/a')
  })

  it('links only to http(s) addresses', async () => {
    render(<PageChip page={{ ...page, url: 'javascript:alert(1)' }} conversationId="c" messageId="m" />)
    await userEvent.click(screen.getByRole('button'))
    expect(screen.queryByRole('link')).toBeNull()
  })
})
