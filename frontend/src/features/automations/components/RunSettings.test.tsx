import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { type RunSettingsForm, runSettingsBody, runSettingsFrom } from '../runSettings'

/* The tools an automation's runs may use, MCP tools included (spec 02 section 3). */
vi.mock('../api', () => ({
  useToolCatalog: () => ({
    data: [
      { name: 'list_events', description: 'List events.', capability: 'calendar.read', server: null },
      { name: 'mcp__artemk__open_requests', description: 'Booking requests that wait for an answer.', capability: 'mcp.artemk.open_requests', server: 'artemk' },
    ],
  }),
}))

const { RunSettings } = await import('./RunSettings')

function Harness({ onForm }: { onForm: (form: RunSettingsForm) => void }) {
  const [form, setForm] = useState(runSettingsFrom(null))
  return <RunSettings form={form} editing={false} onChange={(next) => { setForm(next); onForm(next) }} />
}

describe('the run settings', () => {
  it('put the tools of a connected MCP server on the list', async () => {
    let form = runSettingsFrom(null)
    render(<Harness onForm={(next) => { form = next }} />)
    await userEvent.click(screen.getByRole('radio', { name: 'Only these:' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'mcp__artemk__open_requests' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'list_events' }))
    expect(runSettingsBody(form).tool_allowlist).toEqual(['mcp__artemk__open_requests', 'list_events'])
    expect(screen.getByRole('checkbox', { name: 'mcp__artemk__open_requests' }).closest('label'))
      .toHaveAttribute('title', 'Booking requests that wait for an answer.')
  })

  it('say that {today} in a check’s arguments is today’s date', async () => {
    let form = runSettingsFrom(null)
    render(<Harness onForm={(next) => { form = next }} />)
    expect(screen.getByText(/In the arguments, \{today\} stands for today’s date\./)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Add a check' }))
    await userEvent.type(screen.getByRole('combobox', { name: 'Tool' }), 'mcp__artemk__list_bookings')
    const args = screen.getByRole('textbox', { name: 'Arguments (JSON)' })
    await userEvent.clear(args)
    // (userEvent reads braces as key names: they are typed doubled.)
    await userEvent.type(args, '{{"from_date": "{{today}"}')
    await userEvent.type(screen.getByRole('textbox', { name: /Run anyway every/ }), '6')
    expect(runSettingsBody(form).change_check).toEqual([{ tool: 'mcp__artemk__list_bookings', args: { from_date: '{today}' } }])
    expect(runSettingsBody(form).run_anyway_hours).toBe(6)
  })
})
