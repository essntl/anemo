import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { monthGrid } from '../monthGrid'
import { MiniMonth } from './MiniMonth'

describe('monthGrid', () => {
  it('covers whole weeks, Monday first', () => {
    // November 2026 starts on a Sunday and has 30 days: six weeks from Oct 26 to Dec 6.
    const days = monthGrid(2026, 10)
    expect(days).toHaveLength(42)
    expect(days[0]).toBe('2026-10-26')
    expect(days[days.length - 1]).toBe('2026-12-06')
    // February 2027 starts on a Monday and has 28 days: exactly four weeks.
    expect(monthGrid(2027, 1)).toHaveLength(28)
  })
})

describe('MiniMonth', () => {
  it('marks today and takes the calendar to a clicked day', async () => {
    const onPick = vi.fn()
    render(<MiniMonth shown={{ start: '2026-11-09', end: '2026-11-16' }} today="2026-11-10" onPick={onPick} />)
    expect(screen.getByText('November 2026')).toBeInTheDocument()
    const today = screen.getByRole('button', { current: 'date' })
    expect(today).toHaveTextContent('10')
    await userEvent.click(screen.getByRole('button', { name: /November 19/ }))
    expect(onPick).toHaveBeenCalledWith('2026-11-19')
  })

  it('its arrows page the month without moving the calendar', async () => {
    const onPick = vi.fn()
    render(<MiniMonth shown={{ start: '2026-11-09', end: '2026-11-16' }} today="2026-11-10" onPick={onPick} />)
    await userEvent.click(screen.getByRole('button', { name: 'Next month' }))
    expect(screen.getByText('December 2026')).toBeInTheDocument()
    expect(onPick).not.toHaveBeenCalled()
  })
})
