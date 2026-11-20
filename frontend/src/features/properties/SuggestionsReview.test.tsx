import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const suggestion = (id: string, title: string) => ({
  id, document_id: `d-${id}`, title, path: `documents/${id}.md`, current: {}, suggested: { type: 'plan' }, actor_ref: 'chat:x',
})
const applyMutate = vi.fn()
const dismissMutate = vi.fn()
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  useSuggestions: () => ({ data: [suggestion('a', 'Old offer'), suggestion('b', 'Old plan')] }),
  useProperties: () => ({ data: [] }),
  useApplySuggestions: () => ({ mutate: applyMutate, isPending: false }),
  useDismissSuggestions: () => ({ mutate: dismissMutate, isPending: false }),
}))

const { SuggestionsReview } = await import('./SuggestionsReview')

describe('suggested properties', () => {
  it('applies the chosen ones and dismisses others', () => {
    render(<SuggestionsReview />)
    fireEvent.click(screen.getByRole('button', { name: /2 suggested property changes/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Apply to Old plan' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply selected' }))
    expect(applyMutate).toHaveBeenCalledWith(['a'], expect.anything())
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss selected' }))
    expect(dismissMutate).toHaveBeenCalledWith(['a', 'b'], expect.anything())
  })
})
