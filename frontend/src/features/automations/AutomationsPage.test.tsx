import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/* "Pause all" and who set an automation up. */
const state = vi.hoisted(() => ({
  automations: [] as Record<string, unknown>[],
  protections: { paused: false, max_run_minutes: 30 },
  save: vi.fn(),
}))
const idle = { mutate: vi.fn(), isPending: false, error: null }
vi.mock('./api', () => ({
  STATUS_LABELS: {},
  useAutomations: () => ({ data: state.automations, isSuccess: true, isError: false }),
  useAutomationRuns: () => ({ data: [] }),
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

const show = () => render(<MemoryRouter><AutomationsPage /></MemoryRouter>)

describe('the automations page', () => {
  beforeEach(() => {
    state.automations = [automation()]
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
})
