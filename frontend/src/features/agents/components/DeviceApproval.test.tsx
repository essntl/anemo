import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolCallView } from '../api'

const mutate = vi.fn()
vi.mock('../api', () => ({
  useDecide: () => ({ mutate, isPending: false, isError: false }),
  useTimeline: () => ({ data: undefined }),
}))

const { ApprovalCard } = await import('./ApprovalCard')

function shellCall(device: object): ToolCallView {
  return {
    id: 'c1', step: 0, position: 0, tool_name: 'computer_shell', capability: 'computer.shell', args: {},
    actions: [{ capability: 'computer.shell', summary: 'Run PowerShell', risk: 'dangerous', device }],
    risk: 'dangerous', decision: 'ask', decision_reason: 'profile Scoped asks first', status: 'waiting_approval',
    result: null, result_data: null, is_error: false, started_at: null, ended_at: null,
    approval: { id: 'a1', kind: 'action', status: 'pending', summary: 'Run PowerShell `Remove-Item …`' },
  } as unknown as ToolCallView
}

const readable = {
  device_id: 'd1', device_name: 'Main PC', rule: 'deletes C:\\Users\\a\\Pictures\\x, outside the work folders',
  effects: [{ kind: 'delete', path: 'C:\\Users\\a\\Pictures\\x' }], unknown: [],
  folder: 'C:\\Users\\a\\Pictures', parent_folder: 'C:\\Users\\a', scopes: ['once', 'folder', 'hour'],
}

const render_ = (call: ToolCallView) => render(<MemoryRouter><ApprovalCard runId="r1" call={call} /></MemoryRouter>)

describe('the approval of a command on a computer (spec 25 §6.2)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows the rule and the effects, and offers Once, This folder and The next hour', async () => {
    render_(shellCall(readable))
    expect(screen.getByTestId('device-approval')).toHaveTextContent('outside the work folders')
    expect(screen.getByText('C:\\Users\\a\\Pictures\\x')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Allow for this run' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'This folder' }))
    expect(mutate).toHaveBeenCalledWith({ approvalId: 'a1', decision: 'approve', scope: 'folder', folder: 'C:\\Users\\a\\Pictures' })
    await userEvent.click(screen.getByRole('checkbox'))
    await userEvent.click(screen.getByRole('button', { name: 'The next hour' }))
    expect(mutate).toHaveBeenLastCalledWith({ approvalId: 'a1', decision: 'approve', scope: 'hour', folder: 'C:\\Users\\a' })
    await userEvent.click(screen.getByRole('button', { name: 'Once' }))
    expect(mutate).toHaveBeenLastCalledWith({ approvalId: 'a1', decision: 'approve', scope: 'once', folder: undefined })
  })

  it('offers only Once in a protected folder, and "this exact command" for one it can’t read', () => {
    const { unmount } = render_(shellCall({ ...readable, folder: null, parent_folder: null, scopes: ['once'] }))
    expect(screen.getByRole('button', { name: 'Once' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'This folder' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'The next hour' })).not.toBeInTheDocument()
    unmount()
    render_(shellCall({ ...readable, folder: null, parent_folder: null, unknown: ['variable $p used as a path'], scopes: ['once', 'command'] }))
    expect(screen.getByText(/It can’t tell: variable \$p/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'This exact command for the next hour' })).toBeInTheDocument()
  })
})
