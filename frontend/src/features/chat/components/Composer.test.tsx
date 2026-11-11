import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { Composer } from './Composer'

// The hook returns the skills themselves (an array), not a query.
vi.mock('@/features/profiles/api', () => ({ useSlashSkills: () => [] }))
vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: () => false }))

function renderComposer(onSend: (text: string) => void | Promise<unknown>) {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Composer running={false} onSend={onSend} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('the message box', () => {
  it('is cleared when the message is sent', async () => {
    const onSend = vi.fn(() => Promise.resolve())
    renderComposer(onSend)
    const box = screen.getByRole('textbox')
    await userEvent.type(box, 'Hello there{Enter}')
    expect(onSend).toHaveBeenCalledWith('Hello there', [], [], null)
    expect(box).toHaveValue('')
  })

  it('gets the message back when sending fails', async () => {
    let fail!: (err: Error) => void
    renderComposer(() => new Promise((_, reject) => { fail = reject }))
    const box = screen.getByRole('textbox')
    await userEvent.type(box, 'Please keep this{Enter}')
    expect(box).toHaveValue('')
    fail(new Error('offline'))
    await vi.waitFor(() => expect(box).toHaveValue('Please keep this'))
  })

  it("doesn't overwrite what was typed after a failed send", async () => {
    let fail!: (err: Error) => void
    renderComposer(() => new Promise((_, reject) => { fail = reject }))
    const box = screen.getByRole('textbox')
    await userEvent.type(box, 'First{Enter}')
    await userEvent.type(box, 'Second')
    fail(new Error('offline'))
    await new Promise((r) => setTimeout(r, 0))
    expect(box).toHaveValue('Second')
  })
})
