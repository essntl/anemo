import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { codeJob } from './testJobs'

const toggled: { jobId: string; enabled: boolean }[] = []
vi.mock('./api', () => ({
  useAutoContinue: () => ({ isPending: false, mutate: (v: { jobId: string; enabled: boolean }) => toggled.push(v) }),
}))
vi.mock('@/components/ui/toast', () => ({ toast: vi.fn() }))

const { LimitPanel } = await import('./LimitPanel')

const soon = () => new Date(Date.now() + 2 * 3600_000).toISOString()
const limited = (more = {}) => codeJob({ id: 'j1', state: 'failed', is_error: true, limit_hit: true, limit_resets_at: soon(), ...more })

beforeEach(() => {
  toggled.length = 0
})

describe('Limit reached', () => {
  it('says when the limit resets, and the switch turns auto continue on', async () => {
    render(<LimitPanel job={limited()} last />)
    const panel = screen.getByTestId('limit-panel')
    expect(panel).toHaveTextContent('Limit reached')
    expect(panel).toHaveTextContent(/The usage limit resets (Today|Tomorrow) \d/)
    const toggle = screen.getByRole('switch', { name: 'Auto continue' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    await userEvent.click(toggle)
    expect(toggled).toEqual([{ jobId: 'j1', enabled: true }])
  })

  it('shows the scheduled continue, also while the computer is away, and turns it off', async () => {
    render(<LimitPanel job={limited({
      resume_state: 'scheduled', resume_at: soon(),
      device: { id: 'dev-1', name: 'Desk PC', online: false, last_seen_at: null, share: false, start: false, cancel: false },
    })} last />)
    expect(screen.getByTestId('limit-status')).toHaveTextContent(/^Continues by itself (Today|Tomorrow) .*, in the same session\. Desk PC is offline: it continues as soon as it is back\.$/)
    const toggle = screen.getByRole('switch', { name: 'Auto continue' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(toggle)
    expect(toggled).toEqual([{ jobId: 'j1', enabled: false }])
  })

  it('says why a continue was cancelled or stopped, and that one started', () => {
    const { rerender } = render(<LimitPanel job={limited({ resume_state: 'cancelled', resume_note: 'You sent a message meanwhile.' })} last />)
    expect(screen.getByTestId('limit-status')).toHaveTextContent('You sent a message meanwhile.')
    rerender(<LimitPanel job={limited({ resume_state: 'started' })} last={false} />)
    expect(screen.getByTestId('limit-status')).toHaveTextContent('Continued in the next job of this thread.')
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })

  it('has no switch on an earlier job of the thread, and an unknown reset says so', () => {
    render(<LimitPanel job={limited({ limit_resets_at: null })} last={false} />)
    expect(screen.getByTestId('limit-panel')).toHaveTextContent('When the usage limit resets isn’t known')
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })

  it('is not there for a job that didn’t stop at the limit, or one that runs or was cancelled', () => {
    const { container, rerender } = render(<LimitPanel job={codeJob({ state: 'failed' })} last />)
    expect(container).toBeEmptyDOMElement()
    rerender(<LimitPanel job={limited({ state: 'running' })} last />)
    expect(container).toBeEmptyDOMElement()
    rerender(<LimitPanel job={limited({ state: 'cancelled' })} last />)
    expect(container).toBeEmptyDOMElement()
  })
})
