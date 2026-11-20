import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { noteServerTime } from '@/lib/serverClock'
import type { Timeline, ToolCallView } from '../api'

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0)
const at = (secondsFromNow: number) => new Date(NOW + secondsFromNow * 1000).toISOString()

let timeline: Timeline
vi.mock('../api', () => ({
  useTimeline: () => ({ data: timeline }),
  useRevertChange: () => ({ mutateAsync: vi.fn(), isPending: false, isError: false }),
}))
vi.mock('@/features/runs/api', () => ({
  toolOutputUrl: () => '',
  useEditPlan: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useRun: () => ({ data: undefined }),
}))
vi.mock('./RunControls', () => ({ RunControls: () => null }))
vi.mock('./SubagentRun', () => ({ SubagentRun: () => null }))

const { RunActivity } = await import('./RunActivity')

function call(id: string, tool: string, over: Partial<ToolCallView>): ToolCallView {
  return {
    id,
    step: 0,
    position: 0,
    tool_name: tool,
    capability: null,
    args: {},
    actions: [{ summary: `${tool} ${id}` }],
    risk: 'safe',
    decision: 'allow',
    decision_reason: null,
    status: 'succeeded',
    result: null,
    result_data: null,
    is_error: false,
    started_at: null,
    ended_at: null,
    approval: null,
    ...over,
  } as ToolCallView
}

describe('tool call durations', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    noteServerTime(new Response(null, { headers: { 'X-Server-Time': String(NOW) } }))
    timeline = {
      run_id: 'r1',
      kind: 'agent',
      status: 'running',
      pause_requested: false,
      plan: null,
      plan_version: 0,
      file_changes: [],
      tool_calls: [
        call('a', 'read_file', { started_at: at(-200), ended_at: at(-75) }),
        call('b', 'run_subagent', { status: 'waiting_child', started_at: at(-7) }),
        call('c', 'delete_path', { status: 'denied', decision: 'deny' }),
        call('d', 'run_shell', { status: 'cancelled', started_at: at(-30), ended_at: at(-28) }),
      ],
    } as Timeline
  })
  afterEach(() => vi.useRealTimers())

  it('shows how long each call took, and counts a running one live', () => {
    render(<RunActivity runId="r1" live />)
    const row = (name: string) => screen.getByText(name).closest('button')!
    expect(row('read_file a')).toHaveTextContent('2 m 05 s')
    expect(row('run_subagent b')).toHaveTextContent('7 s') // a sub-agent's call too
    expect(row('run_shell d')).toHaveTextContent('2 s') // stopped with its run
    expect(row('delete_path c').textContent).not.toMatch(/\d s/) // it never ran
    act(() => void vi.advanceTimersByTime(2000))
    expect(row('run_subagent b')).toHaveTextContent('9 s')
    expect(row('read_file a')).toHaveTextContent('2 m 05 s')
  })

  it('shows the answer’s timer beside "Working…" while the run goes on', () => {
    const { rerender } = render(<RunActivity runId="r1" live timer={<span>12 s</span>} />)
    const bar = screen.getByText('Working…').closest('button')!
    expect(bar).toHaveTextContent('Working…12 s')
    timeline = { ...timeline, status: 'completed' }
    rerender(<RunActivity runId="r1" live={false} timer={<span>12 s</span>} />)
    expect(screen.queryByText('12 s')).not.toBeInTheDocument()
  })
})
