import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { formFrom, missingRequired, typeDefaults } from '../triggerForm'

/* A trigger on an MCP server's notifications: the server is picked by name (and must be),
   the resource URI is a field, and bursts are coalesced by default. */
const state = vi.hoisted(() => ({ save: vi.fn() }))
const mcpType = {
  type: 'mcp.notification', label: 'MCP server notification', description: 'A connected MCP server sent a notification.',
  fields: [
    { name: 'server_id', label: 'MCP server', kind: 'mcp_server', choices: [], required: true },
    { name: 'method', label: 'Notification', kind: 'enum', choices: ['notifications/resources/updated', 'notifications/tools/list_changed'], required: false },
    { name: 'uri', label: 'Resource URI', kind: 'text', choices: [], required: false },
  ],
}
const catalogue = [
  { type: 'task.created', label: 'Task created', description: 'A task was created.', fields: [] },
  mcpType,
]
vi.mock('../api', () => ({
  useEventCatalogue: () => ({ data: catalogue }),
  useSaveTrigger: () => ({ mutate: state.save, isPending: false, error: null }),
  useRotateSecret: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}))
vi.mock('@/features/mcp/api', () => ({
  useMcpServers: () => ({ data: [{ id: 's1', name: 'Notes', enabled: true }, { id: 's2', name: 'Mail', enabled: false }] }),
}))

Element.prototype.scrollIntoView ??= () => {}

const { TriggerDialog } = await import('./TriggerDialog')

async function pick(name: RegExp, option: string) {
  screen.getByRole('combobox', { name }).focus()
  await userEvent.keyboard('{Enter}')
  await userEvent.click(await screen.findByRole('option', { name: option }))
}

describe('a trigger on an MCP server', () => {
  beforeEach(() => state.save.mockReset())

  it('picks the server by name, needs one, and coalesces bursts by default', async () => {
    render(<TriggerDialog automationId="a1" trigger={null} onClose={() => undefined} />)
    await pick(/^Event/, 'MCP server notification')
    const burst = screen.getByRole('spinbutton', { name: /^Coalesce bursts \(seconds\)/ })
    expect(burst).toHaveValue(30)
    const add = screen.getByRole('button', { name: 'Add trigger' })
    expect(add).toBeDisabled() // no server yet
    screen.getByRole('combobox', { name: /^MCP server \*/ }).focus()
    await userEvent.keyboard('{Enter}')
    expect(await screen.findByRole('option', { name: 'Mail (off)' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('option', { name: 'Notes' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Resource URI' }), 'note://a')
    expect(add).toBeEnabled()
    await userEvent.click(add)
    const [{ create }] = state.save.mock.calls[0] as [{ create: Record<string, unknown> }]
    expect(create).toMatchObject({
      event_type: 'mcp.notification', filter: { server_id: 's1', uri: 'note://a' }, debounce_s: 30,
    })
  })
})

describe('the form rules', () => {
  it('knows a required field is empty, and keeps a burst window that was set', () => {
    const form = formFrom(null, 'mcp.notification')
    expect(missingRequired(form, mcpType)).toBe(true)
    expect(missingRequired({ ...form, filter: { server_id: 's1' } }, mcpType)).toBe(false)
    expect(typeDefaults('mcp.notification', form)).toEqual({ debounceS: 30 })
    expect(typeDefaults('mcp.notification', { ...form, debounceS: 5 })).toEqual({})
    expect(typeDefaults('task.created', form)).toEqual({})
  })
})
