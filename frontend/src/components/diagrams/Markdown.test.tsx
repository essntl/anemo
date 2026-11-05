import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Markdown } from '@/components/ui/Markdown'
import { DiagramFixContext } from './context'

const CHART = '```chart\n{"type": "bar", "title": "Hours", "x": ["Mon", "Tue"], "series": [{"name": "Focus", "values": [2, 3]}]}\n```'

describe('Markdown with diagrams, charts and math', () => {
  it('draws a chart, and shows its source on request', async () => {
    render(<Markdown text={`Here:\n\n${CHART}\n`} />)
    const chart = screen.getByRole('img', { name: /Hours/ })
    expect(chart.querySelectorAll('rect').length).toBeGreaterThan(2)
    expect(chart.querySelector('desc')?.textContent).toBe('Bar chart "Hours". Focus: Mon 2, Tue 3.')
    await userEvent.click(screen.getByRole('button', { name: 'Source' }))
    expect(screen.getByText(/"type": "bar"/)).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: /Hours/ })).toBeNull()
  })

  it('shows a block still being written as code, and draws it once complete', () => {
    const partial = CHART.slice(0, CHART.lastIndexOf('```'))
    const { rerender } = render(<Markdown text={partial} streaming />)
    expect(screen.queryByRole('img', { name: /Hours/ })).toBeNull()
    expect(screen.getByText('chart')).toBeInTheDocument() // the code block's label
    rerender(<Markdown text={CHART} streaming />)
    expect(screen.getByRole('img', { name: /Hours/ })).toBeInTheDocument()
  })

  it('explains a chart that cannot be drawn, with Fix diagram in a chat', async () => {
    const fix = vi.fn()
    render(
      <DiagramFixContext.Provider value={fix}>
        <Markdown text={'```chart\n{"type": "radar"}\n```'} />
      </DiagramFixContext.Provider>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('This chart can’t be drawn. "type" must be one of line, bar, area, pie.')
    await userEvent.click(screen.getByRole('button', { name: 'Fix diagram' }))
    expect(fix).toHaveBeenCalledWith({ kind: 'chart', source: '{"type": "radar"}', error: expect.stringContaining('"type"') })
  })

  it('has no Fix diagram button outside a chat', () => {
    render(<Markdown text={'```chart\nnope\n```'} />)
    expect(screen.getByRole('alert')).toHaveTextContent('not valid JSON')
    expect(screen.queryByRole('button', { name: 'Fix diagram' })).toBeNull()
  })

  it('renders math with KaTeX and leaves prices alone', async () => {
    const { container } = render(<Markdown text={'Area: $\\pi r^2$. It costs $5 and $10.'} />)
    await waitFor(() => expect(container.querySelector('.katex')).not.toBeNull())
    expect(container.querySelectorAll('.katex').length).toBe(1)
    expect(container.textContent).toContain('It costs $5 and $10.')
  })

  it('keeps other code blocks as they were', () => {
    render(<Markdown text={'```python\nprint("hi")\n```'} />)
    expect(screen.getByText('python')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
  })
})
