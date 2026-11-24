import { act, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
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

describe('Claude Code jobs', () => {
  it('links a code tool call to the job it names', () => {
    timeline = {
      run_id: 'r2', kind: 'agent', status: 'completed', pause_requested: false, plan: null, plan_version: 0, file_changes: [],
      tool_calls: [
        call('s', 'code_start', { result_data: { code_job_id: 'job-1' } }),
        call('t', 'code_status', { result_data: { code_job_id: 'job-2' } }),
        call('x', 'code_cancel', { result_data: { code_job_id: 'job-3' } }),
        // Another tool naming a job, or a code tool that names none: no chip.
        call('o', 'read_file', { result_data: { code_job_id: 'job-4' } }),
        call('n', 'code_projects', { result_data: null }),
      ],
    } as Timeline
    render(<MemoryRouter><RunActivity runId="r2" live={false} /></MemoryRouter>)
    // Collapsed after the run: open it.
    act(() => screen.getByText('5 actions').closest('button')!.click())
    const chips = screen.getAllByRole('link', { name: 'Claude Code job' })
    expect(chips.map((a) => a.getAttribute('href'))).toEqual(['/code/job-1', '/code/job-2', '/code/job-3'])
  })
})

describe('generated images', () => {
  it('shows the pictures a generate_image call made, each linked to its file', () => {
    timeline = {
      run_id: 'r3', kind: 'agent', status: 'completed', pause_requested: false, plan: null, plan_version: 0, file_changes: [],
      tool_calls: [
        call('g', 'generate_image', {
          result_data: {
            generated: [
              { path: 'files/generated/2026-11-24/fox-1.png', width: 1536, height: 1024, attachment_id: 'att-1' },
              { path: 'files/generated/2026-11-24/fox-2.png', width: 1536, height: 1024, attachment_id: null },
            ],
          },
        }),
      ],
    } as Timeline
    render(<MemoryRouter><RunActivity runId="r3" live={false} /></MemoryRouter>)
    act(() => screen.getByText('1 action').closest('button')!.click())
    const links = screen.getAllByRole('link', { name: /files\/generated/ })
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/files?path=files/generated/2026-11-24/fox-1.png',
      '/files?path=files/generated/2026-11-24/fox-2.png',
    ])
    // Only a picture with a copy under the answer is shown (from Anemo, not the provider).
    expect(screen.getAllByRole('img').map((i) => i.getAttribute('src'))).toEqual(['/api/attachments/att-1/content'])
  })
})
