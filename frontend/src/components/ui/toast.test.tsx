import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toast, useToasts } from './toast'
import { ToastHost } from './ToastHost'
import { liftFor } from './useToastLift'

afterEach(() => {
  vi.useRealTimers()
  act(() => useToasts.setState({ toasts: [] }))
})

describe('toasts', () => {
  it('shows a notice whose action runs once and closes it', async () => {
    const user = userEvent.setup()
    const undo = vi.fn()
    render(<ToastHost />)
    act(() => toast({ message: 'Saved to memory: Likes tea.', action: { label: 'Undo', onClick: undo } }))
    expect(screen.getByText('Saved to memory: Likes tea.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    expect(undo).toHaveBeenCalledTimes(1)
    // It animates out first, then it is gone.
    await waitFor(() => expect(screen.queryByText('Saved to memory: Likes tea.')).not.toBeInTheDocument())
  })

  it('keeps at most three on screen; the older ones fold into "+N more"', async () => {
    const user = userEvent.setup()
    render(<ToastHost />)
    act(() => {
      for (const n of [1, 2, 3, 4, 5]) toast({ message: `Notice ${n}` })
    })
    expect(screen.getAllByRole('status').map((el) => el.textContent)).toEqual(['Notice 3', 'Notice 4', 'Notice 5'])
    await user.click(screen.getByRole('button', { name: '+2 more' }))
    expect(screen.getAllByRole('status')).toHaveLength(5)
    await user.click(screen.getByRole('button', { name: 'Dismiss all' }))
    await waitFor(() => expect(screen.queryAllByRole('status')).toHaveLength(0))
  })

  it('closes after its time, which waits while the pointer is over it', () => {
    vi.useFakeTimers()
    render(<ToastHost />)
    act(() => toast({ message: 'Copied', duration: 4000 }))
    const host = screen.getByRole('region', { name: 'Notices' })
    act(() => vi.advanceTimersByTime(3000))
    fireEvent.pointerEnter(host, { pointerType: 'mouse' })
    act(() => vi.advanceTimersByTime(10_000))
    expect(useToasts.getState().toasts[0].leaving).toBeUndefined() // still there, waiting
    expect(screen.getByTestId('toast-time')).toHaveStyle({ animationPlayState: 'paused' })
    fireEvent.pointerLeave(host)
    act(() => vi.advanceTimersByTime(900))
    expect(useToasts.getState().toasts[0].leaving).toBeUndefined() // the second it had left is not up yet
    act(() => vi.advanceTimersByTime(200))
    expect(useToasts.getState().toasts[0].leaving).toBe(true)
  })

  it('announces warnings and errors at once, other notices politely', () => {
    render(<ToastHost />)
    act(() => {
      toast({ message: 'Saved' })
      toast({ title: 'Price watch failed', message: 'The page answered 503.', level: 'error' })
    })
    expect(screen.getByRole('status')).toHaveTextContent('Saved')
    expect(screen.getByRole('alert')).toHaveTextContent('Price watch failedThe page answered 503.')
    expect(screen.getByRole('alert')).toHaveAttribute('data-level', 'error')
  })

  it('a rich notice shows its title, text and action; Escape closes it', async () => {
    const user = userEvent.setup()
    const open = vi.fn()
    render(<ToastHost />)
    act(() => toast({ title: 'Job finished', message: 'All tests pass.', level: 'success', action: { label: 'View job', onClick: open } }))
    const note = screen.getByRole('status')
    expect(note).toHaveTextContent('Job finished')
    expect(note).toHaveTextContent('All tests pass.')
    await user.click(screen.getByRole('button', { name: 'View job' }))
    expect(open).toHaveBeenCalledTimes(1)
    act(() => toast({ message: 'Another' }))
    const another = screen.getByText('Another').closest('[role=status]') as HTMLElement
    act(() => another.querySelector('button')!.focus())
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByText('Another')).not.toBeInTheDocument())
  })

  it('goes when swiped sideways, and springs back from a short drag', () => {
    render(<ToastHost />)
    act(() => toast({ message: 'Swipe me' }))
    const note = screen.getByRole('status')
    note.setPointerCapture = () => {}
    fireEvent.pointerDown(note, { pointerType: 'touch', clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(note, { pointerType: 'touch', clientX: 130, pointerId: 1 })
    fireEvent.pointerUp(note, { pointerType: 'touch', clientX: 130, pointerId: 1 })
    expect(useToasts.getState().toasts[0].leaving).toBeUndefined()
    fireEvent.pointerDown(note, { pointerType: 'touch', clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(note, { pointerType: 'touch', clientX: 200, pointerId: 1 })
    fireEvent.pointerUp(note, { pointerType: 'touch', clientX: 200, pointerId: 1 })
    expect(useToasts.getState().toasts[0].leaving).toBe(true)
  })
})

describe('the lift above a docked message box or tab bar', () => {
  it('clears an element docked at the bottom, and nothing else', () => {
    expect(liftFor({ top: 740, bottom: 800, height: 60 }, 800)).toBe(60) // the tab bar
    expect(liftFor({ top: 0, bottom: 0, height: 0 }, 800)).toBe(0) // hidden (display: none)
    expect(liftFor({ top: 300, bottom: 420, height: 120 }, 800)).toBe(0) // a new chat's box mid-screen
  })
})
