import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'

const sent = vi.fn()
let fail: unknown = null
vi.mock('./api', () => ({
  sendMessage: async (_qc: unknown, jobId: string, prompt: string, images: { id: string }[] = []) => {
    sent(jobId, prompt, images.map((i) => i.id))
    if (fail) throw fail
    return {}
  },
}))
const toasts = vi.hoisted(() => [] as string[])
vi.mock('@/components/ui/toast', () => ({ toast: (o: { message: string }) => toasts.push(o.message) }))

const { CodeQueueRunner } = await import('./CodeQueueRunner')
const { useCodeQueue } = await import('./queueStore')

const client = new QueryClient()
const ui = () => <QueryClientProvider client={client}><CodeQueueRunner /></QueryClientProvider>

beforeEach(() => {
  vi.clearAllMocks()
  toasts.length = 0
  fail = null
  localStorage.clear()
  useCodeQueue.setState({ byThread: {}, drafts: {}, draftImages: {} })
})

// Messages are kept on the server now (code-sessions.md §15): what an older page queued in
// this browser is moved there once.
describe('the old browser queue', () => {
  it('moves each message to the server, with its images, and forgets it here', async () => {
    useCodeQueue.setState({ byThread: { t1: { jobId: 'a', text: 'Then run the tests', images: [{ id: 'att-1', name: 'a.png', size: 1 }] } } })
    render(ui())
    await waitFor(() => expect(sent).toHaveBeenCalledWith('a', 'Then run the tests', ['att-1']))
    await waitFor(() => expect(useCodeQueue.getState().byThread.t1).toBeUndefined())
    expect(toasts).toEqual([])
  })

  it('moves a held message too: the server decides what to do with it', async () => {
    useCodeQueue.setState({ byThread: { t1: { jobId: 'a', text: 'Try again', held: 'The job didn’t finish.' } } })
    render(ui())
    await waitFor(() => expect(sent).toHaveBeenCalledWith('a', 'Try again', []))
  })

  it('puts a message the server refuses back into its thread’s box', async () => {
    fail = new ApiError(404, 'not_found', 'Claude Code job not found')
    useCodeQueue.setState({
      byThread: { t1: { jobId: 'gone', text: 'Lost?', images: [{ id: 'att-2', name: 'b.png', size: 1 }] } },
      drafts: { t1: 'typed meanwhile' },
    })
    render(ui())
    await waitFor(() => expect(useCodeQueue.getState().drafts.t1).toBe('Lost?\n\ntyped meanwhile'))
    expect(useCodeQueue.getState().draftImages?.t1?.map((i) => i.id)).toEqual(['att-2'])
    expect(useCodeQueue.getState().byThread.t1).toBeUndefined()
    expect(toasts).toEqual(['A queued message couldn’t be sent: it is back in its thread’s box.'])
  })

  it('does nothing without such messages', () => {
    render(ui())
    expect(sent).not.toHaveBeenCalled()
  })
})
