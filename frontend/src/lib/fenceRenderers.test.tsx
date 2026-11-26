import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { Markdown } from '@/components/ui/Markdown'
import { fenceRenderer, type FenceRendererProps, registerFenceRenderer } from './fenceRenderers'

/* The fence-renderer registry, and Markdown drawing a registered fence in chat answers only. */

function Kanban({ lang, text }: FenceRendererProps) {
  return <div data-testid="kanban">{lang}: {text}</div>
}

const answer = '```today-kanban\nTodo: tea\n```'
const show = (fences: boolean, text = answer) => render(<MemoryRouter><Markdown text={text} fences={fences} /></MemoryRouter>)

describe('fence renderers', () => {
  let stops: (() => void)[] = []
  afterEach(() => {
    stops.forEach((stop) => stop())
    stops = []
  })

  it('registers and removes a renderer, case-insensitively', () => {
    stops.push(registerFenceRenderer('Today-Kanban', Kanban))
    expect(fenceRenderer('today-kanban')).toBe(Kanban)
    stops.pop()?.()
    expect(fenceRenderer('today-kanban')).toBeUndefined()
  })

  it('never takes over the languages Anemo draws itself', () => {
    stops.push(registerFenceRenderer('mermaid', Kanban))
    expect(fenceRenderer('mermaid')).toBeUndefined()
  })

  it('lets an older registration not remove a newer one', () => {
    const Other = () => null
    const first = registerFenceRenderer('board', Kanban)
    stops.push(registerFenceRenderer('board', Other))
    first()
    expect(fenceRenderer('board')).toBe(Other)
  })

  it('draws a registered fence in a chat answer, and plain code elsewhere', () => {
    stops.push(registerFenceRenderer('today-kanban', Kanban))
    const chat = show(true)
    expect(screen.getByTestId('kanban')).toHaveTextContent('today-kanban: Todo: tea')
    chat.unmount()
    show(false)
    expect(screen.queryByTestId('kanban')).toBeNull()
    expect(screen.getByText('Todo: tea')).toBeInTheDocument()
  })

  it('shows the code until a renderer is registered for its language', () => {
    show(true)
    expect(screen.getByText('today-kanban')).toBeInTheDocument() // the code block's language label
    expect(screen.queryByTestId('kanban')).toBeNull()
  })
})
