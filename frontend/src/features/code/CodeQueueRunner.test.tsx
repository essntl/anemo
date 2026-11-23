import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import { codeJob } from './testJobs'
import type { CodeJob } from './threads'

const sent = vi.fn()
let fail: unknown = null
let thread: CodeJob[] = []
let loadError = false
vi.mock('./api', async (importOriginal) => ({
  startErrorMessage: (await importOriginal<typeof import('./api')>()).startErrorMessage,
  sendFollowUp: async (_qc: unknown, jobId: string, prompt: string) => { sent(jobId, prompt); if (fail) throw fail; return {} },
  useCodeJob: () => (loadError ? { data: undefined, isError: true } : { data: thread.length ? { job: thread[0], thread } : undefined, isError: false }),
}))
const toasts = vi.hoisted(() => [] as string[])
vi.mock('@/components/ui/toast', () => ({ toast: (o: { message: string }) => toasts.push(o.message) }))

const { CodeQueueRunner } = await import('./CodeQueueRunner')
const { codeQueue, useCodeQueue } = await import('./queueStore')

const client = new QueryClient()
const ui = () => <QueryClientProvider client={client}><CodeQueueRunner /></QueryClientProvider>
const queued = () => useCodeQueue.getState().byThread.t1
const job = (more: Partial<CodeJob> = {}) => codeJob({ id: 'a', thread_id: 't1', title: 'Fix the footer', session_id: 'sess-a', started_at: '2026-11-23T10:00:00Z', ...more })

beforeEach(() => {
  vi.clearAllMocks()
  toasts.length = 0
  fail = null
  loadError = false
  thread = []
  localStorage.clear()
  useCodeQueue.setState({ byThread: {}, drafts: {} })
})

describe('the queue', () => {
  it('waits while the job runs, then sends the message to the thread’s last job', async () => {
    thread = [job({ state: 'running' })]
    codeQueue.add('t1', 'a', 'Then the tests')
    const { rerender } = render(ui())
    expect(sent).not.toHaveBeenCalled()
    expect(queued()).toBeDefined()
    thread = [job({ state: 'done' })]
    rerender(ui())
    await waitFor(() => expect(sent).toHaveBeenCalledWith('a', 'Then the tests'))
    await waitFor(() => expect(queued()).toBeUndefined())
    expect(sent).toHaveBeenCalledTimes(1)
    expect(toasts).toEqual(['Queued message sent: “Fix the footer”'])
  })

  it('follows up the latest job of the thread, also after a cancel', async () => {
    thread = [job({ state: 'done' }), job({ id: 'b', state: 'cancelled', session_id: 'sess-b', started_at: '2026-11-23T11:00:00Z' })]
    codeQueue.add('t1', 'a', 'Do this instead')
    render(ui())
    await waitFor(() => expect(sent).toHaveBeenCalledWith('b', 'Do this instead'))
  })

  it.each([
    ['a failed job', { state: 'failed' as const }, 'The job didn’t finish, so this message wasn’t sent.'],
    ['a job that exited without a result', { state: 'exited_without_result' as const }, 'The job didn’t finish, so this message wasn’t sent.'],
    ['no session', { session_id: null }, 'The job left no session to continue, so this message wasn’t sent.'],
    ['an offline computer', { device: { ...codeJob().device, online: false } }, 'Desk PC went offline, so this message wasn’t sent.'],
    ['a computer that stopped allowing jobs', { device: { ...codeJob().device, start: false } }, 'Desk PC no longer lets Anemo start jobs, so this message wasn’t sent.'],
  ])('holds the message after %s', async (_name, more, reason) => {
    thread = [job({ state: 'done', ...more })]
    codeQueue.add('t1', 'a', 'Next')
    render(ui())
    await waitFor(() => expect(queued()).toEqual({ jobId: 'a', text: 'Next', held: reason }))
    expect(sent).not.toHaveBeenCalled()
    expect(toasts).toEqual([`“Fix the footer”: ${reason}`])
  })

  it('holds the message with the server’s reason when sending fails, and doesn’t try again by itself', async () => {
    fail = new ApiError(409, 'device_busy', 'Desk PC is busy.')
    thread = [job({ state: 'done' })]
    codeQueue.add('t1', 'a', 'Next')
    const { rerender } = render(ui())
    await waitFor(() => expect(queued()?.held).toBe('Desk PC is busy.'))
    rerender(ui())
    expect(sent).toHaveBeenCalledTimes(1)
  })

  it('holds the message when its job is gone', async () => {
    loadError = true
    codeQueue.add('t1', 'a', 'Next')
    render(ui())
    await waitFor(() => expect(queued()?.held).toBe('The job can’t be loaded, so this message wasn’t sent.'))
  })

  it('doesn’t send a message another tab already took', async () => {
    thread = [job({ state: 'running' })]
    codeQueue.add('t1', 'a', 'Once')
    const { rerender } = render(ui())
    // The other tab sent it: storage no longer has it, this tab's memory still does.
    localStorage.setItem('anemo.codeQueue', JSON.stringify({ state: { byThread: {} }, version: 0 }))
    thread = [job({ state: 'done' })]
    rerender(ui())
    await waitFor(() => expect(queued()).toBeUndefined())
    expect(sent).not.toHaveBeenCalled()
  })
})
