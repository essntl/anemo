import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/* The trigger dialog: the event picker from the catalogue, the filter fields, the limits,
   and a webhook's URL and secret (shown once). */
const state = vi.hoisted(() => ({
  save: vi.fn(),
  rotate: vi.fn(),
}))
const catalogue = [
  { type: 'task.created', label: 'Task created', description: 'A task was created.',
    fields: [{ name: 'tags', label: 'Tag', kind: 'tags', choices: [] }, { name: 'status', label: 'Status', kind: 'enum', choices: ['todo', 'done'] }] },
  { type: 'code_job.ended', label: 'Claude Code job ended', description: 'A Claude Code job ended.',
    fields: [{ name: 'job_id', label: 'Job', kind: 'id', choices: [] }] },
  { type: 'webhook.received', label: 'Webhook', description: 'Another service called it.', fields: [] },
]
vi.mock('../api', () => ({
  useEventCatalogue: () => ({ data: catalogue }),
  useSaveTrigger: () => ({ mutate: state.save, isPending: false, error: null }),
  useRotateSecret: () => ({ mutate: state.rotate, isPending: false, error: null }),
}))

// Radix's select scrolls to the chosen option; jsdom has no layout.
Element.prototype.scrollIntoView ??= () => {}

const { TriggerDialog } = await import('./TriggerDialog')

describe('the trigger dialog', () => {
  beforeEach(() => {
    state.save.mockReset()
    state.rotate.mockReset()
  })

  it('adds a trigger with a filter, a burst window and a limit', async () => {
    render(<TriggerDialog automationId="a1" trigger={null} onClose={() => undefined} />)
    expect(screen.getByText('A task was created.')).toBeInTheDocument()
    await userEvent.type(screen.getByRole('textbox', { name: 'Tag' }), 'urgent, home')
    const burst = screen.getByRole('spinbutton', { name: /^Coalesce bursts \(seconds\)/ })
    await userEvent.clear(burst)
    await userEvent.type(burst, '60')
    await userEvent.click(screen.getByRole('checkbox', { name: 'Only once (switch it off after it fired)' }))
    await userEvent.click(screen.getByRole('button', { name: 'Add trigger' }))
    expect(state.save).toHaveBeenCalledOnce()
    const [{ create }] = state.save.mock.calls[0] as [{ create: Record<string, unknown> }]
    expect(create).toMatchObject({
      automation_id: 'a1', event_type: 'task.created', filter: { tags: ['urgent', 'home'] },
      debounce_s: 60, max_per_hour: 12, once: true, expires_at: null, enabled: true,
    })
  })

  it('shows a new webhook’s URL and secret once', async () => {
    state.save.mockImplementation((_v, opts: { onSuccess: (r: unknown) => void }) =>
      opts.onSuccess({ trigger: { webhook_url: 'https://anemo.example/api/hooks/t1' }, secret: 'whsec_abc' }))
    render(<TriggerDialog automationId="a1" trigger={null} onClose={() => undefined} />)
    screen.getByRole('combobox', { name: /^Event/ }).focus()
    await userEvent.keyboard('{Enter}')
    await userEvent.click(await screen.findByRole('option', { name: 'Webhook' }))
    await userEvent.click(screen.getByRole('button', { name: 'Add trigger' }))
    expect(await screen.findByText('Webhook ready')).toBeInTheDocument()
    expect(screen.getByText('https://anemo.example/api/hooks/t1')).toBeInTheDocument()
    expect(screen.getByText('whsec_abc')).toBeInTheDocument()
  })

  it('changes a webhook trigger, keeps it a webhook, and makes a new secret', async () => {
    const hook = {
      id: 't1', automation_id: 'a1', conversation_id: null, kind: 'automation' as const, event_type: 'webhook.received', event_label: 'Webhook',
      filter: {}, once: false, expires_at: null, debounce_s: 0, max_per_hour: 12, enabled: true, note: '', created_by: 'user',
      fire_count: 0, last_fired_at: null, dropped_count: 0, last_drop_reason: null, waiting: false,
      webhook_url: 'https://anemo.example/api/hooks/t1', has_secret: true, created_at: '2026-11-20T09:00:00Z',
    }
    render(<TriggerDialog automationId="a1" trigger={hook} onClose={() => undefined} />)
    expect(screen.getByRole('combobox', { name: /^Event/ })).toBeDisabled()
    expect(screen.queryByText(/whsec_/)).not.toBeInTheDocument()  // never shown again
    await userEvent.click(screen.getByRole('button', { name: 'New secret' }))
    expect(state.rotate).toHaveBeenCalledWith('t1', expect.anything())
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(state.save.mock.calls[0][0]).toMatchObject({ id: 't1', patch: { event_type: 'webhook.received', max_per_hour: 12 } })
  })
})
