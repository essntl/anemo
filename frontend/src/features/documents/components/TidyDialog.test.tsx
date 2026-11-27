import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  ask: vi.fn(),
  apply: vi.fn(),
  result: undefined as unknown,
}))
vi.mock('../api', () => ({
  TIDY_MAX: 3,
  useTidySuggestions: () => ({
    mutate: (v: unknown, o: { onSuccess: (r: unknown) => void }) => { mocks.ask(v); o.onSuccess(mocks.result) },
    data: mocks.result, isPending: false, isError: false,
  }),
  useApplyTidy: () => ({ mutate: mocks.apply, isPending: false }),
}))
vi.mock('@/features/properties/api', () => ({
  useProperties: () => ({ data: [{ key: 'type', label: 'Type', type: 'select', options: [{ slug: 'plan', label: 'Plan' }, { slug: 'note', label: 'Note' }] }] }),
  valueLabel: (d: { options: { slug: string; label: string }[] } | undefined, v: unknown) => d?.options.find((o) => o.slug === v)?.label ?? String(v),
}))

const { TidyDialog } = await import('./TidyDialog')

const suggestion = (document_id: string, title: string, changes: unknown[], current = {}) =>
  ({ document_id, title, path: `documents/${document_id}.md`, folder: '', current, changes, why: 'tidier' })

beforeEach(() => {
  mocks.ask.mockClear()
  mocks.apply.mockClear()
  mocks.result = {
    considered: 3, failed: 0, model: 'small',
    suggestions: [
      suggestion('a', 'Prompt: Anemo agent – fix it', [{ kind: 'archive' }, { kind: 'title', title: 'Fix it' }]),
      suggestion('b', 'Launch', [{ kind: 'property', key: 'type', value: 'plan' }, { kind: 'folder', folder: 'work' }], { type: 'note' }),
    ],
  }
})

describe('the tidy-up review', () => {
  it('asks about the documents in view, at most the limit, and says so', () => {
    render(<TidyDialog ids={['a', 'b', 'c', 'd']} within="thesis" onClose={() => {}} />)
    expect(mocks.ask).toHaveBeenCalledWith({ ids: ['a', 'b', 'c'], within: 'thesis' })
    expect(screen.getByText(/Only the 3 most recently changed of the 4 documents/)).toBeInTheDocument()
  })

  it('lists each change of each document with its own checkbox, all chosen at first', () => {
    render(<TidyDialog ids={['a', 'b']} within={null} onClose={() => {}} />)
    const first = screen.getByRole('region', { name: 'Prompt: Anemo agent – fix it' })
    expect(within(first).getAllByRole('checkbox')).toHaveLength(2)
    expect(within(first).getByText('Archive')).toBeInTheDocument()
    expect(within(first).getByText(/Rename to/)).toHaveTextContent('Rename to “Fix it”')
    const second = screen.getByRole('region', { name: 'Launch' })
    expect(second).toHaveTextContent('Type: Note')
    expect(second).toHaveTextContent('Plan')
    expect(second).toHaveTextContent('Move to work')
    expect(screen.getAllByRole('checkbox').every((c) => (c as HTMLInputElement).checked)).toBe(true)
    expect(screen.getByRole('button', { name: 'Apply 4 selected' })).toBeEnabled()
  })

  it('applies only what is chosen', async () => {
    render(<TidyDialog ids={['a', 'b']} within={null} onClose={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: 'Reject all' }))
    expect(screen.getByRole('button', { name: 'Apply 0 selected' })).toBeDisabled()
    const second = screen.getByRole('region', { name: 'Launch' })
    await userEvent.click(within(second).getAllByRole('checkbox')[1]) // the move only
    await userEvent.click(screen.getByRole('button', { name: 'Apply 1 selected' }))
    expect(mocks.apply).toHaveBeenCalledWith({ changes: [{ kind: 'folder', folder: 'work', document_id: 'b' }], within: null }, expect.anything())

    await userEvent.click(screen.getByRole('button', { name: 'Accept all' }))
    await userEvent.click(screen.getByRole('button', { name: 'Apply 4 selected' }))
    expect(mocks.apply.mock.calls[1][0].changes).toHaveLength(4)
  })

  it('says when there is nothing to suggest, and when some documents were not looked at', () => {
    mocks.result = { considered: 5, failed: 2, model: 'small', suggestions: [] }
    render(<TidyDialog ids={['a']} within={null} onClose={() => {}} />)
    expect(screen.getByText(/no suggestions/)).toBeInTheDocument()
    expect(screen.getByText(/2 documents couldn’t be looked at/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Apply/ })).toBeNull()
  })
})
