import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/* The Scripts tab: who wrote a script, a change waiting for review (the switch is
 * blocked until then), the diff of that change and approving exactly that version. */
const state = vi.hoisted(() => ({
  script: null as Record<string, unknown> | null,
  approve: vi.fn(),
  discard: vi.fn(),
  setEnabled: vi.fn(),
}))
const idle = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, error: null }
vi.mock('../api', () => ({
  STATUS_LABELS: {},
  STATUS_TONES: {},
  useScript: () => ({ data: state.script, isSuccess: true, isError: false, error: null }),
  useApproveScript: () => ({ ...idle, mutate: state.approve }),
  useDiscardScriptChange: () => ({ ...idle, mutate: state.discard }),
  useScriptSecret: () => idle,
  useSetAutomationEnabled: () => ({ ...idle, mutate: state.setEnabled }),
  useRunAutomation: () => idle,
  useDeleteAutomation: () => idle,
  useAutomationRuns: () => ({ data: [] }),
  useAutomationRun: () => ({ data: undefined }),
}))
vi.mock('./ScriptDialog', () => ({ ScriptDialog: () => null }))
vi.mock('@/components/ui/ActionMenu', () => ({ ActionMenu: () => null })) // needs matchMedia, which jsdom lacks

const { ScriptsTab } = await import('./ScriptsTab')

const automation = (over: Record<string, unknown> = {}) => ({
  id: 's1', kind: 'script', name: 'Bookings', prompt: 'Turns bookings into tasks', schedule_text: 'Only when started',
  enabled: false, next_run_at: null, last_run_at: null, last_status: null, active_run_id: null, created_by: 'agent',
  script_approved: true, script_pending: true, pending_approvals: [], ...over,
})
const version = (over: Record<string, unknown> = {}) => ({
  number: 1, hash: 'a'.repeat(64), code: 'one\ntwo', tools: ['create_task'], hosts: [], secrets: [], think_tools: [],
  created_by: { ref: 'user', kind: 'user', label: 'You', url: null }, created_at: '2026-11-20T10:00:00Z', approved_at: '2026-11-20T10:00:00Z',
  ...over,
})
const chat = { ref: 'chat:c1', kind: 'chat', label: 'Planning', url: '/c/c1' }

const show = (scripts = [automation()]) =>
  render(<MemoryRouter><ScriptsTab scripts={scripts as never} linked={null} linkedRun={null} /></MemoryRouter>)

describe('the scripts tab', () => {
  beforeEach(() => {
    state.script = {
      automation_id: 's1',
      approved: version(),
      pending: version({ number: 2, hash: 'b'.repeat(64), code: 'one\nthree', tools: ['create_task', 'http_request'], hosts: ['api.example.com'], created_by: chat, approved_at: null }),
      owner: chat,
      secrets: [],
    }
    state.approve.mockReset()
    state.setEnabled.mockReset()
  })

  it('shows who wrote it and blocks the switch while a change waits for review', () => {
    show()
    expect(screen.getByText('Change waiting for review')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Written by the assistant in “Planning”' })).toHaveAttribute('href', '/c/c1')
    expect(screen.getByRole('switch', { name: 'Run “Bookings”' })).toBeDisabled()
    expect(screen.getByText('Review the change first')).toBeInTheDocument()
  })

  it('lets an approved script without a change be switched on', async () => {
    state.script = { ...(state.script as object), pending: null }
    show([automation({ script_pending: false })])
    await userEvent.click(screen.getByRole('switch', { name: 'Run “Bookings”' }))
    expect(state.setEnabled).toHaveBeenCalledWith({ id: 's1', enabled: true })
  })

  it('shows the diff and approves exactly the version shown', async () => {
    show()
    await userEvent.click(screen.getByRole('button', { name: 'Review change' }))
    const dialog = await screen.findByRole('dialog')
    const code = within(dialog).getByLabelText('Code')
    expect(code).toHaveTextContent('removed: two')
    expect(code).toHaveTextContent('added: three')
    expect(within(dialog).getByText('+ http_request')).toBeInTheDocument()
    expect(within(dialog).getByText('+ api.example.com')).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve and switch on' }))
    expect(state.approve).toHaveBeenCalledWith({ id: 's1', hash: 'b'.repeat(64), enable: true }, expect.anything())
  })
})
