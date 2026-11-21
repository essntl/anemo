import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ list: [] as { method: string; path: string; init: unknown }[] }))

vi.mock('@/api/client', () => ({
  api: {
    GET: async () => ({ data: undefined }),
    PUT: async (path: string, init: { body: unknown }) => {
      calls.list.push({ method: 'PUT', path, init })
      return { data: init.body }
    },
    POST: async (path: string, init: unknown) => {
      calls.list.push({ method: 'POST', path, init })
      return { data: { run_id: 'r1', user_message: null, assistant_message: { id: 'a1' } } }
    },
  },
  unwrap: (r: { data: unknown }) => r.data,
  errorMessage: (e: unknown) => String(e),
}))

const { ReasoningControl } = await import('./ReasoningControl')
const { useChatModel } = await import('../chatModel')
const { useSendTurn, useRegenerate } = await import('../api')

const MODELS = [
  { id: 'thinker', display_name: 'Thinker', enabled: true, provider_enabled: true, provider_type: 'anthropic', capabilities: { chat: true, reasoning: true } },
  { id: 'plain', display_name: 'Plain', enabled: true, provider_enabled: true, provider_type: 'openai', capabilities: { chat: true } },
  { id: 'local', display_name: 'Local', enabled: true, provider_enabled: true, provider_type: 'openai_compatible', capabilities: { chat: true, reasoning: true } },
]

function client(effort = 'medium') {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
  qc.setQueryData(['models'], MODELS)
  qc.setQueryData(['settings'], { models: { chat: 'thinker', fallbacks: {}, reasoning_effort: effort } })
  return qc
}

/** As the chat pages do: the control is offered when the chosen model's level can be set. */
function Controls({ modelId }: { modelId: string }) {
  return useChatModel(modelId).reasons ? <ReasoningControl /> : null
}

function picker(modelId: string, qc = client()) {
  render(
    <QueryClientProvider client={qc}>
      <Controls modelId={modelId} />
    </QueryClientProvider>,
  )
  return qc
}

beforeEach(() => {
  calls.list.length = 0
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.releasePointerCapture = () => {}
  Element.prototype.scrollIntoView = () => {}
  // Radix Popover measures its arrow; jsdom has no ResizeObserver.
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
})

describe('the reasoning control next to the model', () => {
  it('shows only for a model whose provider is told how hard to think', () => {
    picker('thinker')
    expect(screen.getByRole('button', { name: 'Reasoning: Medium' })).toBeInTheDocument()
  })

  it('is left out for a model that cannot reason, or a server that gets no level', () => {
    picker('plain')
    expect(screen.queryByRole('button', { name: /^Reasoning/ })).not.toBeInTheDocument()
    picker('local')
    expect(screen.queryByRole('button', { name: /^Reasoning/ })).not.toBeInTheDocument()
  })

  it('opens the slider and saves a new level as the default, keeping the other defaults', async () => {
    const qc = picker('thinker')
    await userEvent.click(screen.getByRole('button', { name: 'Reasoning: Medium' }))
    const slider = await screen.findByRole('slider', { name: 'Reasoning effort' })
    slider.focus()
    await userEvent.keyboard('{End}')
    await waitFor(() => expect(calls.list).toHaveLength(1))
    expect(calls.list[0]).toMatchObject({
      method: 'PUT',
      path: '/api/settings/models',
      init: { body: { chat: 'thinker', fallbacks: {}, reasoning_effort: 'max' } },
    })
    // Shown at once, before the save comes back.
    expect(screen.getByRole('button', { name: 'Reasoning: Max' })).toBeInTheDocument()
    expect(qc.getQueryData<{ models: { reasoning_effort: string } }>(['settings'])?.models.reasoning_effort).toBe('max')
  })
})

describe('sending with the chosen level', () => {
  const wrapper = (qc: QueryClient) => ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )

  it('sends the slider’s level with a message and with an answer again', async () => {
    const qc = client('high')
    const send = renderHook(() => useSendTurn(), { wrapper: wrapper(qc) })
    await act(() => send.result.current.mutateAsync({ conversationId: 'c1', text: 'hi', modelId: null }))
    expect(calls.list[0].path).toBe('/api/conversations/{conversation_id}/turns')
    expect((calls.list[0].init as { body: { reasoning_effort: string } }).body.reasoning_effort).toBe('high')

    const again = renderHook(() => useRegenerate(), { wrapper: wrapper(qc) })
    await act(() => again.result.current.mutateAsync({ conversationId: 'c1', modelId: 'thinker' }))
    expect((calls.list[1].init as { params: { query: unknown } }).params.query).toEqual({ model_id: 'thinker', reasoning_effort: 'high' })
  })
})
