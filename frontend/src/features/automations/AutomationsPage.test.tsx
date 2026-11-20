import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/* "Pause all", who set an automation up, its run log and what it waits for. */
const state = vi.hoisted(() => ({
  automations: [] as Record<string, unknown>[],
  runs: [] as Record<string, unknown>[],
  linked: [] as Record<string, unknown>[],
  asked: [] as (string | null)[],
  protections: { paused: false, max_run_minutes: 30 },
  save: vi.fn(),
}))
const idle = { mutate: vi.fn(), isPending: false, error: null }
vi.mock('./api', () => ({
  STATUS_LABELS: {},
  useAutomations: () => ({ data: state.automations, isSuccess: true, isError: false }),
  useAutomationRuns: () => ({ data: state.runs }),
  useAutomationRun: (_id: string, runId: string | null) => {
    state.asked.push(runId)
    return { data: runId ? state.linked : undefined }
  },
  useDeleteAutomation: () => idle,
  useRunAutomation: () => idle,
  useSetAutomationEnabled: () => idle,
}))
vi.mock('@/features/settings/api', () => ({
  useSettings: () => ({ data: { automations: state.protections } }),
  useSaveSection: () => ({ mutate: state.save, isError: false, error: null }),
}))
vi.mock('./components/AutomationDialog', () => ({ AutomationDialog: () => null }))
vi.mock('@/components/ui/ActionMenu', () => ({ ActionMenu: () => null })) // needs matchMedia, which jsdom lacks

const { AutomationsPage } = await import('./AutomationsPage')

const automation = (over: Record<string, unknown> = {}) => ({
  id: 'a1', name: 'Morning briefing', prompt: 'Give me my day', schedule_text: 'Every weekday at 07:00', enabled: true,
  next_run_at: null, last_run_at: null, last_status: null, active_run_id: null, created_by: 'user', ...over,
})

const show = (url = '/automations') => render(<MemoryRouter initialEntries={[url]}><AutomationsPage /></MemoryRouter>)

const timing = (over: Record<string, unknown> = {}) => ({
  started_at: '2026-11-20T10:00:00Z', finished_at: '2026-11-20T10:01:00Z', outcome: 'done', first_text_at: '2026-11-20T10:00:20Z',
  first_text_waiting_ms: 0, waiting_ms: 0, waiting_since: null, tool_calls: 4, ...over,
})

const logged = (over: Record<string, unknown> = {}) => ({
  run_id: 'r1', status: 'completed', trigger: 'schedule', created_at: '2026-11-20T10:00:00Z', ended_at: '2026-11-20T10:01:00Z',
  outcome_line: 'nothing new', nothing_to_do: true, changes: [], conversation_id: 'c1', error: null, timing: timing(), ...over,
})

describe('the automations page', () => {
  beforeEach(() => {
    state.automations = [automation()]
    state.runs = []
    state.linked = []
    state.asked = []
    state.protections = { paused: false, max_run_minutes: 30 }
    state.save.mockReset()
  })

  it('pauses every schedule with one switch, keeping the other protections', async () => {
    show()
    expect(screen.getByText(/stopped after 30 minutes/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('switch', { name: 'Pause all automations' }))
    expect(state.save).toHaveBeenCalledWith({ paused: true, max_run_minutes: 30 })
  })

  it('says so while everything is paused, also with no automations to show', () => {
    state.protections = { paused: true, max_run_minutes: 30 }
    state.automations = []
    show()
    expect(screen.getByText('All automations are paused')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Pause all automations' })).toBeChecked()
  })

  it('marks what the assistant set up', () => {
    state.automations = [automation(), automation({ id: 'a2', name: 'Price check', created_by: 'agent' })]
    show()
    expect(screen.getAllByText('Set up by the assistant')).toHaveLength(1)
  })

  it('shows the run log: outcome lines, runs that did nothing, and what a run changed', async () => {
    state.runs = [
      logged({ run_id: 'r2', outcome_line: 'added request #12', nothing_to_do: false,
        changes: [{ tool: 'create_event', summary: 'Add event: Request #12', ref: '/calendar?event=e1' }] }),
      logged(),
      logged({ run_id: 'r3', status: 'failed', outcome_line: null, nothing_to_do: false, error: 'Stopped after 30 tool calls.' }),
    ]
    show()
    await userEvent.click(screen.getByRole('button', { name: 'History' }))
    expect(screen.getByText('added request #12')).toBeInTheDocument()
    expect(screen.getByText('nothing new')).toBeInTheDocument()
    expect(screen.getAllByText('Nothing to do')).toHaveLength(1)
    expect(screen.getByText('Stopped after 30 tool calls.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '1 change' }))
    expect(screen.getByRole('link', { name: 'Add event: Request #12' })).toHaveAttribute('href', '/calendar?event=e1')
  })

  it('says how long each run took, with the same details as the chat', async () => {
    state.runs = [
      logged({ run_id: 'r2', ended_at: '2026-11-20T10:03:05Z',
        timing: timing({ finished_at: '2026-11-20T10:03:05Z', waiting_ms: 60_000, tool_calls: 7 }) }),
      logged({ run_id: 'r3', status: 'failed', outcome_line: null, timing: timing({ outcome: 'failed', finished_at: '2026-11-20T10:00:41Z' }) }),
    ]
    show()
    await userEvent.click(screen.getByRole('button', { name: 'History' }))
    // The minute it waited for you is not part of it.
    const duration = screen.getByRole('button', { name: /2 m 05 s/ })
    expect(screen.getByRole('button', { name: /Failed after 41 s/ })).toBeInTheDocument()
    await userEvent.click(duration)
    const details = screen.getByRole('tooltip')
    expect(details).toHaveTextContent('Total2 m 05 s')
    expect(details).toHaveTextContent('Waiting for you1 m 00 s')
    expect(details).toHaveTextContent('Tool calls7')
  })

  it('counts up while a run works, and stands still while it waits for you', async () => {
    state.runs = [logged({ run_id: 'r4', status: 'waiting_approval', ended_at: null, outcome_line: null, nothing_to_do: false,
      timing: timing({ finished_at: null, outcome: null, waiting_since: '2026-11-20T10:00:30Z' }) })]
    show()
    await userEvent.click(screen.getByRole('button', { name: 'History' }))
    expect(screen.getByText(/waiting for you/)).toBeInTheDocument()
    expect(screen.getByText('30 s')).toBeInTheDocument()
  })

  it('opens the run log of the automation a link points to, at that run', () => {
    state.automations = [automation(), automation({ id: 'a2', name: 'Bookings' })]
    state.runs = [logged({ run_id: 'r9', nothing_to_do: false, changes: [{ tool: 'update_event', summary: 'Moved #3' }] })]
    show('/automations?automation=a2&run=r9')
    // Only that automation's history is open, and the linked run shows its changes.
    expect(screen.getAllByText('nothing new')).toHaveLength(1)
    expect(screen.getByText('Moved #3')).toBeInTheDocument()
  })

  it('fetches a linked run that is older than the log shows', () => {
    state.runs = [logged({ run_id: 'r-new', outcome_line: 'newest' })]
    state.linked = [logged({ run_id: 'r-old', outcome_line: 'a run from long ago', nothing_to_do: false })]
    show('/automations?automation=a1&run=r-old')
    expect(state.asked).toContain('r-old')
    expect(screen.getByText('a run from long ago')).toBeInTheDocument()
    expect(screen.getByText('newest')).toBeInTheDocument()
  })

  it('shows repeated failures and the approvals its runs wait for', () => {
    state.automations = [automation({
      failure_streak: 3, last_error: 'provider down',
      pending_approvals: [{ approval_id: 'p1', run_id: 'r1', conversation_id: 'c7', summary: 'Write notes/a.md', created_at: '2026-11-20T10:00:00Z' }],
    })]
    show()
    expect(screen.getByText('Failed 3 times in a row: provider down')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Review and approve' })).toHaveAttribute('href', '/c/c7')
  })
})
