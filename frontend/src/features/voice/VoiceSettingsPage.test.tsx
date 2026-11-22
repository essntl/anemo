import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const puts = vi.hoisted(() => ({ calls: [] as { path: string; body: unknown }[] }))

vi.mock('@/api/client', () => ({
  api: {
    GET: async () => ({ data: [] }),
    PUT: async (path: string, init: { body: unknown }) => { puts.calls.push({ path, body: init.body }); return { data: init.body } },
  },
  unwrap: (r: { data: unknown }) => r.data,
  errorMessage: (e: unknown) => String(e),
}))

const { VoiceSettingsPage } = await import('./VoiceSettingsPage')

const DEFAULTS = { profile_id: null, model_id: null, follow_up_minutes: 5, max_spoken_chars: 600, approvals_by_voice: true, chat: 'daily' }

function show() {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
  qc.setQueryData(['settings'], { voice: DEFAULTS })
  render(<MemoryRouter><QueryClientProvider client={qc}><VoiceSettingsPage /></QueryClientProvider></MemoryRouter>)
}

beforeEach(() => {
  puts.calls.length = 0
})

describe('Settings > Voice', () => {
  it('saves a changed follow-up window and the approvals switch', async () => {
    show()
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    const minutes = screen.getByRole('spinbutton', { name: 'Follow-up window (minutes)' })
    await userEvent.clear(minutes)
    await userEvent.type(minutes, '75')  // more than the hour allowed
    await userEvent.click(screen.getByRole('switch', { name: 'Allow approvals by voice' }))
    await userEvent.click(save)
    await waitFor(() => expect(puts.calls).toHaveLength(1))
    expect(puts.calls[0].path).toBe('/api/settings/voice')
    expect(puts.calls[0].body).toEqual({ ...DEFAULTS, follow_up_minutes: 60, approvals_by_voice: false })
  })
})
