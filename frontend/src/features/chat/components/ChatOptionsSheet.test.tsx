import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mode } from '@/features/agents/components/ModeSwitch'
import { recentModels } from '../recentModels'

vi.mock('@/api/client', () => ({
  api: { GET: async () => ({ data: undefined }), PUT: async (_p: string, init: { body: unknown }) => ({ data: init.body }) },
  unwrap: (r: { data: unknown }) => r.data,
  errorMessage: (e: unknown) => String(e),
}))

const { ChatOptionsSheet } = await import('./ChatOptionsSheet')

const model = (id: string, extra: object = {}) => ({
  id, display_name: `Model ${id}`, provider_name: 'Lemon', provider_type: 'openai', enabled: true, provider_enabled: true, capabilities: { chat: true }, ...extra,
})
// Fourteen usable models, one switched off, and one that can reason.
const MODELS = [
  ...Array.from({ length: 13 }, (_, i) => model(String(i + 1))),
  model('thinker', { display_name: 'Thinker', provider_name: 'Anthropic', provider_type: 'anthropic', capabilities: { chat: true, reasoning: true } }),
  model('off', { enabled: false }),
]
const PROFILES = [{ id: 'p1', name: 'Researcher', description: 'Cites its sources' }]

function open(props: { modelId?: string; mode?: Mode; profileId?: string | null } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
  qc.setQueryData(['models'], MODELS)
  qc.setQueryData(['profiles'], PROFILES)
  qc.setQueryData(['settings'], { models: { chat: '2', fallbacks: {}, reasoning_effort: 'medium' } })
  qc.setQueryData(['permissions', 'summary', props.profileId ?? null], { items: [], max_steps: 1, max_tool_calls: 1, max_runtime_s: 60, plan_review: 'off' })
  const onModel = vi.fn()
  const onProfile = vi.fn()
  const onOpenChange = vi.fn()
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ChatOptionsSheet open onOpenChange={onOpenChange} modelId={props.modelId ?? '2'} defaultModelId="2" onModel={onModel}
          mode={props.mode ?? 'chat'} profileId={props.profileId ?? null} onProfile={onProfile} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { onModel, onProfile, onOpenChange }
}

beforeEach(() => localStorage.clear())

describe('the message box’s options sheet', () => {
  it('lists a few models first and the rest under “Other models”, with a search', async () => {
    open({ modelId: '7' })
    const first = screen.getByRole('radiogroup', { name: 'Model' })
    expect(within(first).getAllByRole('radio').map((r) => r.textContent)).toEqual([
      'Model 1Lemon', 'Model 2Lemon · Default', 'Model 3Lemon', 'Model 7Lemon',
    ])
    expect(within(first).getByRole('radio', { name: /Model 7/ })).toBeChecked()
    const others = screen.getByRole('radiogroup', { name: 'Other models' })
    expect(within(others).getAllByRole('radio')).toHaveLength(10)
    expect(within(others).queryByRole('radio', { name: /Model off/ })).not.toBeInTheDocument()

    await userEvent.type(screen.getByRole('textbox', { name: 'Search models' }), 'think')
    expect(within(others).getAllByRole('radio').map((r) => r.textContent)).toEqual(['ThinkerAnthropic'])
    await userEvent.type(screen.getByRole('textbox', { name: 'Search models' }), 'zzz')
    expect(within(others).getByText('No model matches “thinkzzz”.')).toBeInTheDocument()
  })

  it('chooses a model, remembers it, and keeps the list as it was', async () => {
    const { onModel } = open()
    await userEvent.click(screen.getByRole('radio', { name: /Model 9/ }))
    expect(onModel).toHaveBeenCalledWith('9')
    expect(recentModels()).toEqual(['9'])
    // Still among the other models: nothing moved under the finger.
    expect(within(screen.getByRole('radiogroup', { name: 'Other models' })).getByRole('radio', { name: /Model 9/ })).toBeInTheDocument()
    // The default is "no choice of my own".
    await userEvent.click(screen.getByRole('radio', { name: /Model 2/ }))
    expect(onModel).toHaveBeenLastCalledWith(null)
  })

  it('has a bar for reasoning only when the model’s level can be set', async () => {
    open()
    expect(screen.queryByRole('button', { name: /Reasoning/ })).not.toBeInTheDocument()
  })

  it('opens the reasoning bar onto the slider', async () => {
    open({ modelId: 'thinker' })
    const bar = screen.getByRole('button', { name: /Reasoning/ })
    expect(bar).toHaveTextContent('Medium')
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
    await userEvent.click(bar)
    expect(screen.getByRole('slider', { name: 'Reasoning effort' })).toBeInTheDocument()
  })

  it('has the agent’s profile and permissions in Agent mode only', async () => {
    open()
    expect(screen.queryByRole('button', { name: /Agent profile/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Permissions/ })).not.toBeInTheDocument()
  })

  it('chooses an agent profile from its bar, one bar open at a time', async () => {
    const { onProfile } = open({ mode: 'agent' })
    const bar = screen.getByRole('button', { name: /Agent profile/ })
    expect(bar).toHaveTextContent('Default agent')
    await userEvent.click(bar)
    await userEvent.click(screen.getByRole('radio', { name: /Researcher/ }))
    expect(onProfile).toHaveBeenCalledWith('p1')
    await userEvent.click(screen.getByRole('button', { name: /Permissions/ }))
    expect(screen.getByRole('list', { name: 'Permissions' })).toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: /Researcher/ })).not.toBeInTheDocument()
  })

  it('closes with its close button', async () => {
    const { onOpenChange } = open()
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
