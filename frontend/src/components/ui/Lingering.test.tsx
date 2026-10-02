import { act, render, screen } from '@testing-library/react'
import { EXIT_LIMIT_MS, useClosing } from './closing'
import { Lingering } from './Lingering'

function Probe({ name }: { name: string }) {
  const { closing, done } = useClosing()
  return <p>{name} {closing ? 'closing' : 'open'} <button onClick={done}>animation ended</button></p>
}

describe('Lingering', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const show = (value: { name: string } | null) => (
    <Lingering value={value}>{(v) => <Probe name={v.name} />}</Lingering>
  )

  it('keeps showing the last value while it closes, then removes it', () => {
    const { rerender } = render(show({ name: 'Task' }))
    expect(screen.getByText('Task open')).toBeTruthy()

    rerender(show(null))
    expect(screen.getByText('Task closing')).toBeTruthy()

    act(() => { vi.advanceTimersByTime(EXIT_LIMIT_MS) })
    expect(screen.queryByText(/Task/)).toBeNull()
  })

  it('removes it as soon as the closing animation has ended', () => {
    const { rerender } = render(show({ name: 'Task' }))
    rerender(show(null))
    act(() => screen.getByRole('button', { name: 'animation ended' }).click())
    expect(screen.queryByText(/Task/)).toBeNull()
  })

  it('shows nothing when there never was a value, and reopens cleanly', () => {
    const { rerender } = render(show(null))
    expect(screen.queryByText(/open|closing/)).toBeNull()

    rerender(show({ name: 'A' }))
    rerender(show(null))
    rerender(show({ name: 'B' })) // reopened with something else before the first one was gone
    expect(screen.getByText('B open')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(EXIT_LIMIT_MS * 2) })
    expect(screen.getByText('B open')).toBeTruthy()
  })
})
