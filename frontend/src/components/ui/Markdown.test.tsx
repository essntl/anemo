import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { Markdown } from './Markdown'

const ID = '0193a2b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b'
const show = (text: string) => render(<MemoryRouter><Markdown text={text} /></MemoryRouter>)

describe('a sketch embedded in Markdown', () => {
  it('shows the sketch’s image, as a link that opens the sketch', () => {
    const { container } = show(`Our plan:\n\n![Kitchen plan](/documents/${ID})`)
    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe(`/api/documents/${ID}/sketch/preview`)
    expect(img?.getAttribute('alt')).toBe('Kitchen plan')
    expect(img?.closest('a')?.getAttribute('href')).toBe(`/documents/${ID}`)
  })

  it('without an image yet, shows its name, still linking to it', () => {
    const { container } = show(`![Kitchen plan](/documents/${ID})`)
    fireEvent.error(container.querySelector('img')!)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByRole('link', { name: /Kitchen plan/ })).toHaveAttribute('href', `/documents/${ID}`)
  })

  it('leaves an image from another site waiting for a click', () => {
    const { container } = show(`![Kitchen plan](https://example.com/documents/${ID})`)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByRole('button', { name: /show image from example\.com/ })).toBeInTheDocument()
  })
})

describe('code highlighting', () => {
  it('highlights a fenced block once highlight.js has loaded (it loads on demand)', async () => {
    const { container } = show('Try:\n\n```python\ndef hello():\n    return 1\n```\n')
    expect(screen.getByText('python')).toBeInTheDocument() // the block shows at once
    await waitFor(() => expect(container.querySelector('.hljs-keyword')).not.toBeNull())
    expect(container.querySelector('.hljs-keyword')?.textContent).toBe('def')
  })
})
