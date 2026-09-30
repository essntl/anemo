import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { DialogHost } from './DialogHost'
import { confirmDialog, promptDialog } from './dialogs'

describe('in-app dialogs', () => {
  it('prompt: pre-selects the name part and resolves with the typed value', async () => {
    const user = userEvent.setup()
    render(<DialogHost />)
    let answer: Promise<string | null> = Promise.resolve(null)
    act(() => {
      answer = promptDialog({ title: 'Rename file', label: 'New name', initial: 'notes.md', selectName: true })
    })
    const input = await screen.findByRole('textbox')
    expect((input as HTMLInputElement).selectionEnd).toBe(5) // "notes" selected, ".md" kept
    await user.keyboard('ideas')
    await user.keyboard('{Enter}')
    await expect(answer).resolves.toBe('ideas.md')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('prompt: cancel resolves with null, and empty input cannot be submitted', async () => {
    const user = userEvent.setup()
    render(<DialogHost />)
    let answer: Promise<string | null> = Promise.resolve('x')
    act(() => {
      answer = promptDialog({ title: 'New folder', confirmLabel: 'Create' })
    })
    expect(await screen.findByRole('button', { name: 'Create' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await expect(answer).resolves.toBeNull()
  })

  it('confirm: resolves true on confirm, false on Escape; queued dialogs show in turn', async () => {
    const user = userEvent.setup()
    render(<DialogHost />)
    let first: Promise<boolean> = Promise.resolve(false)
    let second: Promise<boolean> = Promise.resolve(true)
    act(() => {
      first = confirmDialog({ title: 'Delete A?', confirmLabel: 'Delete', danger: true })
      second = confirmDialog({ title: 'Delete B?', confirmLabel: 'Delete' })
    })
    expect(await screen.findByText('Delete A?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await expect(first).resolves.toBe(true)
    expect(await screen.findByText('Delete B?')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await expect(second).resolves.toBe(false)
  })
})
