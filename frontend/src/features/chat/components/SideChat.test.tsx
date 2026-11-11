import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const conversation = { id: 'c1', title: 'About the plan', profile_id: 'p9', active_run_id: null }
let messages: { id: string; role: string; text: string; status: string; run_id: string | null }[] = []
const sendTurn = vi.fn(async (_turn: Record<string, unknown>) => ({}))

vi.mock('../api', () => ({
  conversationKey: (id: string) => ['conversation', id],
  conversationsKey: ['conversations'],
  messagesKey: (id: string) => ['messages', id],
  useConversation: () => ({ data: conversation, error: null }),
  useMessages: () => ({ data: messages }),
  useSendTurn: () => ({ mutateAsync: sendTurn }),
  useCancelRun: () => ({ mutate: vi.fn() }),
}))
vi.mock('../runStream', () => ({ useRunStream: () => ({ status: 'queued', text: '', reasoning: '', questions: [] }) }))
vi.mock('@/features/agents/api', () => ({
  refreshTimeline: vi.fn(),
  useDecide: () => ({ mutateAsync: vi.fn() }),
  useTimeline: () => ({ data: undefined }),
}))
vi.mock('@/features/agents/components/ApprovalCard', () => ({ ApprovalDock: () => null }))
vi.mock('@/features/agents/components/RunActivity', () => ({ RunActivity: () => null }))
vi.mock('@/features/runs/api', () => ({ useResumeRun: () => ({ mutateAsync: vi.fn() }) }))
// The message box, reduced to a field and a button.
vi.mock('./Composer', () => ({
  Composer: ({ onSend, placeholder }: { onSend: (text: string, files: string[], chats: string[], skill: string | null) => Promise<unknown>; placeholder?: string }) => (
    <form onSubmit={(e) => {
      e.preventDefault()
      const field = e.currentTarget.elements.namedItem('text') as HTMLInputElement
      void onSend(field.value, [], [], null).catch(() => undefined)
    }}>
      <input name="text" aria-label="Message" placeholder={placeholder} />
      <button type="submit">Send</button>
    </form>
  ),
}))

const { SideChat } = await import('./SideChat')

function show(props: Partial<Parameters<typeof SideChat>[0]> = {}) {
  const handlers = { create: vi.fn(async () => conversation as never), onCreated: vi.fn(), onRestart: vi.fn(), onGone: vi.fn() }
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <SideChat conversationId={null} {...handlers} empty={(ask) => <button type="button" onClick={() => ask('Tidy it up')}>Starter</button>} {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return handlers
}

async function say(text: string) {
  await userEvent.type(screen.getByLabelText('Message'), text)
  await userEvent.click(screen.getByRole('button', { name: 'Send' }))
}

beforeEach(() => {
  messages = []
  sendTurn.mockClear()
})

describe('SideChat', () => {
  it('makes the chat with the first message, and sends it to an agent with what was prepared', async () => {
    const prepare = vi.fn((text: string, first: boolean) => `[${first ? 'first' : 'later'}] ${text}`)
    const handlers = show({ prepare })
    await say('Shorten the intro')
    await waitFor(() => expect(handlers.onCreated).toHaveBeenCalledWith(conversation))
    expect(handlers.create).toHaveBeenCalledTimes(1)
    expect(sendTurn).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'c1', text: '[first] Shorten the intro', mode: 'agent', profileId: 'p9', modelId: null,
    }))
  })

  it('a starter from the empty state sends its message', async () => {
    const handlers = show()
    await userEvent.click(screen.getByRole('button', { name: 'Starter' }))
    await waitFor(() => expect(handlers.onCreated).toHaveBeenCalled())
    expect(sendTurn).toHaveBeenCalledWith(expect.objectContaining({ text: 'Tidy it up' }))
  })

  it('says why when the message could not go out, and makes no chat', async () => {
    const handlers = show({ prepare: () => Promise.reject(new Error('The document could not be saved.')) })
    await say('Shorten the intro')
    expect(await screen.findByRole('alert')).toHaveTextContent('The document could not be saved.')
    expect(handlers.create).not.toHaveBeenCalled()
    expect(sendTurn).not.toHaveBeenCalled()
  })

  it('shows the chat’s messages as they were typed, and sends a follow-up into the same chat', async () => {
    messages = [
      { id: 'm1', role: 'user', text: 'CONTEXT Shorten the intro', status: 'complete', run_id: null },
      { id: 'm2', role: 'assistant', text: 'Done, it is shorter now.', status: 'complete', run_id: 'r1' },
    ]
    const prepare = vi.fn((text: string, first: boolean) => `[${first ? 'first' : 'later'}] ${text}`)
    const handlers = show({ conversationId: 'c1', prepare, display: (text) => text.replace('CONTEXT ', '') })
    expect(screen.getByText('Shorten the intro')).toBeInTheDocument()
    expect(screen.queryByText(/CONTEXT/)).toBeNull()
    expect(screen.getByText('Done, it is shorter now.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open as a full chat' })).toHaveAttribute('href', '/c/c1')

    await say('And the ending')
    await waitFor(() => expect(sendTurn).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'c1', text: '[later] And the ending', mode: 'agent' })))
    expect(handlers.create).not.toHaveBeenCalled()
  })

  it('offers to start a new chat', async () => {
    const handlers = show({ conversationId: 'c1' })
    await userEvent.click(screen.getByRole('button', { name: 'Start a new chat' }))
    expect(handlers.onRestart).toHaveBeenCalled()
  })
})
