import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { noteServerTime } from '@/lib/serverClock'
import type { RunTiming } from '../timing'

// Counts how often an answer's text is drawn.
const drawn = vi.hoisted(() => ({ markdown: 0 }))
vi.mock('@/components/ui/Markdown', () => ({
  Markdown: ({ text }: { text: string }) => {
    drawn.markdown += 1
    return <p>{text}</p>
  },
}))

const { AssistantMessage } = await import('./MessageBubble')

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0)
const at = (secondsFromNow: number) => new Date(NOW + secondsFromNow * 1000).toISOString()
const timing = (over: Partial<RunTiming> = {}): RunTiming => ({
  started_at: at(-41),
  finished_at: at(0),
  outcome: 'done',
  first_text_at: at(-39),
  first_text_waiting_ms: 0,
  waiting_ms: 0,
  waiting_since: null,
  tool_calls: 3,
  ...over,
})
const live = (over: Partial<RunTiming> = {}) => timing({ finished_at: null, outcome: null, ...over })
const timer = () => screen.getByLabelText('Time this answer has taken')

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  noteServerTime(new Response(null, { headers: { 'X-Server-Time': String(NOW) } }))
})
afterEach(() => vi.useRealTimers())

describe('the duration of an answer', () => {
  it('is shown quietly, with the details on hover or click', () => {
    render(<AssistantMessage text="Done." status="complete" timing={timing({ waiting_ms: 9_000, finished_at: at(9) })} />)
    const duration = screen.getByRole('button', { name: 'How long the answer took: 41 s' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    fireEvent.mouseEnter(duration)
    const details = screen.getByRole('tooltip')
    expect(details).toHaveTextContent('Total41 s')
    expect(details).toHaveTextContent('Time to first text2 s')
    expect(details).toHaveTextContent('Waiting for you9 s')
    expect(details).toHaveTextContent('Tool calls3')
    fireEvent.mouseLeave(duration)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    fireEvent.click(duration) // a click keeps them open (phones have no hover)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    fireEvent.keyDown(duration, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('says when the answer was stopped or failed', () => {
    const { rerender } = render(
      <AssistantMessage text="Half" status="cancelled" timing={timing({ outcome: 'stopped', started_at: at(-125) })} />,
    )
    expect(screen.getByRole('button', { name: 'How long the answer took: Stopped after 2 m 05 s' })).toBeInTheDocument()
    expect(screen.queryByText('Stopped')).not.toBeInTheDocument() // said once, with its duration
    rerender(<AssistantMessage text="" status="failed" error="Boom" timing={timing({ outcome: 'failed', first_text_at: null })} />)
    expect(screen.getByRole('button', { name: 'How long the answer took: Failed after 41 s' })).toBeInTheDocument()
  })

  it('is not shown for an answer from before there was a timer', () => {
    render(<AssistantMessage text="Old answer" status="cancelled" timing={null} />)
    expect(screen.queryByRole('button', { name: /How long/ })).not.toBeInTheDocument()
    expect(screen.getByText('Stopped')).toBeInTheDocument()
  })
})

describe('the live timer', () => {
  it('counts while the answer is written, and stands still while it waits for you', () => {
    const writing = live({ started_at: at(-12), waiting_ms: 2_000 })
    const { rerender } = render(<AssistantMessage text="Writ" status="streaming" timing={writing} />)
    expect(timer()).toHaveTextContent('10 s')
    act(() => void vi.advanceTimersByTime(1000))
    expect(timer()).toHaveTextContent('11 s')

    rerender(<AssistantMessage text="Writ" status="waiting_approval" timing={{ ...writing, waiting_since: at(1) }} />)
    expect(timer()).toHaveTextContent(/11 s ?· waiting for you/)
    act(() => void vi.advanceTimersByTime(5000))
    expect(timer()).toHaveTextContent(/11 s ?· waiting for you/)
    expect(vi.getTimerCount()).toBe(0) // nothing ticks while it waits
  })

  it('stands beside "Thinking" before any text', () => {
    render(<AssistantMessage text="" status="streaming" timing={live({ started_at: at(-3) })} />)
    expect(screen.getByRole('status', { name: 'Waiting for the model' })).toHaveTextContent('Thinking3 s')
  })

  it('stops when the answer ends', () => {
    const { rerender } = render(<AssistantMessage text="Writ" status="streaming" timing={live()} />)
    expect(vi.getTimerCount()).toBe(1)
    rerender(<AssistantMessage text="Written" status="complete" timing={timing()} />)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('in a long chat, a tick draws only the timer, not the messages', () => {
    const listDrawn = vi.fn()
    const earlier = Array.from({ length: 200 }, (_, i) => i)
    function Chat() {
      listDrawn()
      return (
        <div>
          {earlier.map((i) => <AssistantMessage key={i} text={`Answer ${i}`} status="complete" timing={timing()} />)}
          <AssistantMessage text="Still writing" status="streaming" timing={live({ started_at: at(0) })} />
        </div>
      )
    }
    render(<Chat />)
    const before = { list: listDrawn.mock.calls.length, markdown: drawn.markdown }
    expect(timer()).toHaveTextContent('0 s')

    act(() => void vi.advanceTimersByTime(5000))
    expect(timer()).toHaveTextContent('5 s')
    expect(listDrawn).toHaveBeenCalledTimes(before.list)
    expect(drawn.markdown).toBe(before.markdown)
  })
})
