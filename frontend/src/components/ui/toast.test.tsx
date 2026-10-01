import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { toast, useToasts } from './toast'
import { ToastHost } from './ToastHost'

describe('toasts', () => {
  it('shows a notice whose action runs once and closes it', async () => {
    const user = userEvent.setup()
    const undo = vi.fn()
    render(<ToastHost />)
    act(() => toast({ message: 'Saved to memory: Likes tea.', action: { label: 'Undo', onClick: undo } }))
    expect(screen.getByText('Saved to memory: Likes tea.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    expect(undo).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Saved to memory: Likes tea.')).not.toBeInTheDocument()
  })

  it('keeps at most three on screen', () => {
    act(() => {
      for (const n of [1, 2, 3, 4]) toast({ message: `Notice ${n}` })
    })
    expect(useToasts.getState().toasts.map((t) => t.message)).toEqual(['Notice 2', 'Notice 3', 'Notice 4'])
  })
})
