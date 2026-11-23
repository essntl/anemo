import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import { codeJob } from './testJobs'

type Callbacks = { onSuccess?: (v: unknown) => void; onError?: (e: unknown) => void }
const cancelJob = vi.fn()
const followUp = vi.fn()
let fail: unknown = null
vi.mock('./api', async (importOriginal) => ({
  startErrorMessage: (await importOriginal<typeof import('./api')>()).startErrorMessage,
  useCancelJob: () => ({ isPending: false, mutate: (id: string, cb: Callbacks) => { cancelJob(id); if (fail) cb.onError?.(fail); else cb.onSuccess?.({}) } }),
  useFollowUp: (jobId: string) => ({ isPending: false, mutate: (prompt: string, cb: Callbacks) => { followUp(jobId, prompt); if (fail) cb.onError?.(fail); else cb.onSuccess?.({}) } }),
  // The queue's own way to send (CodeQueueRunner).
  sendFollowUp: async (_qc: unknown, jobId: string, prompt: string) => { followUp(jobId, prompt); if (fail) throw fail; return {} },
  useCodeJob: () => ({ data: undefined, isError: false }),
}))
const toasts = vi.hoisted(() => [] as string[])
const undo = vi.hoisted(() => [] as (() => void)[])
vi.mock('@/components/ui/toast', () => ({ toast: (o: { message: string; action?: { onClick: () => void } }) => { toasts.push(o.message); if (o.action) undo.push(o.action.onClick) } }))
const confirm = vi.fn()
vi.mock('@/components/ui/dialogs', () => ({ confirmDialog: (...a: unknown[]) => confirm(...a) }))

const { CancelJobButton, FollowUpBox, FromChat } = await import('./controls')
const { codeQueue, useCodeQueue } = await import('./queueStore')

const device = (more: object = {}) => ({ id: 'dev-1', name: 'Desk PC', online: true, last_seen_at: null, share: true, start: true, cancel: true, ...more })
const client = new QueryClient()
const wrap = (ui: ReactNode) => <QueryClientProvider client={client}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>
const show = (ui: ReactNode) => render(wrap(ui))

beforeEach(() => {
  vi.clearAllMocks()
  toasts.length = 0
  fail = null
  localStorage.clear()
  useCodeQueue.setState({ byThread: {}, drafts: {} })
})

describe('Cancel', () => {
  it('asks first, then cancels the running job', async () => {
    confirm.mockResolvedValue(true)
    show(<CancelJobButton job={codeJob({ id: 'r1', state: 'running' })} />)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel job' }))
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Cancel this job?', danger: true }))
    expect(cancelJob).toHaveBeenCalledWith('r1')
  })

  it('says that a queued message goes out when the job is cancelled', async () => {
    confirm.mockResolvedValue(false)
    codeQueue.add('r1', 'r1', 'Do this instead')
    show(<CancelJobButton job={codeJob({ id: 'r1', state: 'running' })} />)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel job' }))
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ cancelLabel: 'Keep running', focusCancel: true, message: expect.stringContaining('Your queued message is then sent as a follow-up') }))
  })

  it('does nothing when the answer is no', async () => {
    confirm.mockResolvedValue(false)
    show(<CancelJobButton job={codeJob({ state: 'running' })} />)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel job' }))
    expect(cancelJob).not.toHaveBeenCalled()
  })

  it('shows the server’s message when cancelling fails', async () => {
    confirm.mockResolvedValue(true)
    fail = new ApiError(409, 'device_offline', 'Desk PC is offline.')
    show(<CancelJobButton job={codeJob({ state: 'running' })} />)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel job' }))
    expect(toasts).toEqual(['Desk PC is offline.'])
  })

  it('is only there while the job runs on a computer that allows cancelling', () => {
    const { rerender } = show(<CancelJobButton job={codeJob({ state: 'done' })} />)
    expect(screen.queryByRole('button', { name: 'Cancel job' })).not.toBeInTheDocument()
    rerender(wrap(<CancelJobButton job={codeJob({ state: 'running', device: device({ cancel: false }) })} />))
    expect(screen.queryByRole('button', { name: 'Cancel job' })).not.toBeInTheDocument()
  })

  it('needs cancel, not start: a paused computer can still cancel', () => {
    show(<CancelJobButton job={codeJob({ state: 'running', device: device({ start: false, cancel: true }) })} />)
    expect(screen.getByRole('button', { name: 'Cancel job' })).toBeInTheDocument()
  })
})

describe('Follow-up', () => {
  const ended = (more = {}) => codeJob({ id: 'j9', state: 'done', session_id: 'sess-9', ...more })

  it('sends with the button, as typed, and clears the box', async () => {
    show(<FollowUpBox job={ended()} />)
    const box = screen.getByRole('textbox', { name: 'Follow-up' })
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    await userEvent.type(box, '   ')
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    await userEvent.type(box, '  Now the changelog  ')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(followUp).toHaveBeenCalledWith('j9', '     Now the changelog  ')
    expect(box).toHaveValue('')
  })

  it('says the follow-up may have started when no answer came', async () => {
    for (const err of [new ApiError(504, 'http_504', 'Gateway Timeout'), new ApiError(502, 'http_502', 'Bad Gateway'), new TypeError('Failed to fetch')]) {
      fail = err
      toasts.length = 0
      const { unmount } = show(<FollowUpBox job={ended()} />)
      await userEvent.type(screen.getByRole('textbox', { name: 'Follow-up' }), 'More')
      await userEvent.click(screen.getByRole('button', { name: 'Send' }))
      expect(toasts).toEqual(['No answer came in time: the job may have started anyway. The list is being refreshed.'])
      unmount()
    }
  })

  it('shows the server’s message when the computer is busy', async () => {
    fail = new ApiError(409, 'device_busy', 'Desk PC is busy with another command. Try again in a moment.')
    show(<FollowUpBox job={ended()} />)
    await userEvent.type(screen.getByRole('textbox', { name: 'Follow-up' }), 'More')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(toasts).toEqual(['Desk PC is busy with another command. Try again in a moment.'])
  })

  it('sends with Ctrl+Enter, not with Enter alone', async () => {
    show(<FollowUpBox job={ended()} />)
    const box = screen.getByRole('textbox', { name: 'Follow-up' })
    await userEvent.type(box, 'Line one{Enter}line two')
    expect(followUp).not.toHaveBeenCalled()
    await userEvent.keyboard('{Control>}{Enter}{/Control}')
    expect(followUp).toHaveBeenCalledWith('j9', 'Line one\nline two')
  })

  it('keeps the text and says why when it fails', async () => {
    fail = new ApiError(409, 'job_running', 'The thread’s last job is still running.')
    show(<FollowUpBox job={ended()} />)
    await userEvent.type(screen.getByRole('textbox', { name: 'Follow-up' }), 'More')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(toasts).toEqual(['The thread’s last job is still running.'])
    expect(screen.getByRole('textbox', { name: 'Follow-up' })).toHaveValue('More')
  })

  it('is hidden while a job runs on a computer that can’t start jobs; says so when there is no session to continue', () => {
    const { container, rerender } = show(<FollowUpBox job={ended({ state: 'running', device: device({ start: false }) })} />)
    expect(container).toBeEmptyDOMElement()
    rerender(wrap(<FollowUpBox job={ended({ session_id: null })} />))
    expect(screen.getByTestId('follow-up-off')).toHaveTextContent('This job left no session to continue: start a new job to try again.')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('keeps what is typed when the thread is left and opened again', async () => {
    const { unmount } = show(<FollowUpBox job={ended()} />)
    await userEvent.type(screen.getByRole('textbox', { name: 'Follow-up' }), 'Half a thought')
    unmount()
    show(<FollowUpBox job={ended()} />)
    expect(screen.getByRole('textbox', { name: 'Follow-up' })).toHaveValue('Half a thought')
  })

  it('says why when the computer is offline or doesn’t allow starting', () => {
    const { rerender } = show(<FollowUpBox job={ended({ device: device({ online: false, start: false }) })} />)
    expect(screen.getByTestId('follow-up-off')).toHaveTextContent('Desk PC is offline: a follow-up can be sent once it is back.')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    rerender(wrap(<FollowUpBox job={ended({ device: device({ start: false }) })} />))
    expect(screen.getByTestId('follow-up-off')).toHaveTextContent(/doesn’t let Anemo start Claude Code jobs/)
  })
})

describe('Queue (while the job runs)', () => {
  const running = (more = {}) => codeJob({ id: 'r1', thread_id: 't1', state: 'running', session_id: 'sess-1', ...more })
  const queued = () => useCodeQueue.getState().byThread.t1

  it('queues the message instead of sending it, and shows it', async () => {
    show(<FollowUpBox job={running()} />)
    const box = screen.getByRole('textbox', { name: 'Message for when this job ends' })
    expect(screen.getByRole('button', { name: 'Queue message' })).toBeDisabled()
    await userEvent.type(box, 'Then run the tests')
    await userEvent.click(screen.getByRole('button', { name: 'Queue message' }))
    expect(followUp).not.toHaveBeenCalled()
    expect(queued()).toEqual({ jobId: 'r1', text: 'Then run the tests' })
    expect(box).toHaveValue('')
    expect(screen.getByTestId('queued-message')).toHaveTextContent('Queued: sent when this job ends')
    expect(screen.getByTestId('queued-message')).toHaveTextContent('Then run the tests')
  })

  it('adds a second message to the first, with Ctrl+Enter too', async () => {
    show(<FollowUpBox job={running()} />)
    await userEvent.type(screen.getByRole('textbox'), 'One')
    await userEvent.keyboard('{Control>}{Enter}{/Control}')
    await userEvent.type(screen.getByRole('textbox'), 'Two')
    await userEvent.keyboard('{Control>}{Enter}{/Control}')
    expect(queued()?.text).toBe('One\n\nTwo')
  })

  it('Edit puts the message back in the box; Remove drops it', async () => {
    codeQueue.add('t1', 'r1', 'Draft')
    show(<FollowUpBox job={running()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(queued()).toBeUndefined()
    expect(screen.getByRole('textbox')).toHaveValue('Draft')
    // Kept as the thread's draft: leaving the thread doesn't lose it.
    expect(useCodeQueue.getState().drafts.t1).toBe('Draft')
    act(() => codeQueue.add('t1', 'r1', 'Again'))
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(queued()).toBeUndefined()
    expect(screen.queryByTestId('queued-message')).not.toBeInTheDocument()
    expect(toasts).toEqual(['Queued message removed'])
    act(() => undo.at(-1)!())
    expect(queued()).toEqual({ jobId: 'r1', text: 'Again' })
  })

  it('a held message says why, and Send now sends it', async () => {
    codeQueue.hold('t1', { jobId: 'r1', text: 'Try again' }, 'The job didn’t finish, so this message wasn’t sent.')
    show(<FollowUpBox job={running({ id: 'r2', state: 'failed' })} />)
    expect(screen.getByTestId('queued-message')).toHaveTextContent('The job didn’t finish, so this message wasn’t sent.')
    await userEvent.click(screen.getByRole('button', { name: 'Send now' }))
    await waitFor(() => expect(followUp).toHaveBeenCalledWith('r2', 'Try again'))
    await waitFor(() => expect(queued()).toBeUndefined())
  })

  it('a held message that fails again stays, with the new reason', async () => {
    fail = new ApiError(409, 'device_busy', 'Desk PC is busy.')
    codeQueue.hold('t1', { jobId: 'r1', text: 'Try again' }, 'Before')
    show(<FollowUpBox job={running({ state: 'done' })} title="Job title" />)
    await userEvent.click(screen.getByRole('button', { name: 'Send now' }))
    await waitFor(() => expect(queued()).toEqual({ jobId: 'r1', text: 'Try again', held: 'Desk PC is busy.' }))
    expect(toasts).toEqual(['“Job title”: Desk PC is busy.'])
  })

  it('the button says a second message is added to the first', async () => {
    codeQueue.add('t1', 'r1', 'One')
    show(<FollowUpBox job={running()} />)
    await userEvent.type(screen.getByRole('textbox'), 'Two')
    await userEvent.click(screen.getByRole('button', { name: 'Add to queue' }))
    expect(queued()?.text).toBe('One\n\nTwo')
  })

  it('a held message can’t be sent where follow-ups can’t: it can still be edited or discarded', async () => {
    codeQueue.hold('t1', { jobId: 'r1', text: 'Later' }, 'Desk PC went offline, so this message wasn’t sent.')
    show(<FollowUpBox job={running({ state: 'done', device: device({ online: false }) })} />)
    expect(screen.queryByRole('button', { name: 'Send now' })).not.toBeInTheDocument()
    expect(screen.getByTestId('follow-up-off')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Discard message' }))
    expect(queued()).toBeUndefined()
  })
})

describe('From chat', () => {
  it('links to the chat whose agent started the job', () => {
    show(<FromChat job={codeJob({ conversation_id: 'c1', conversation_title: 'Release 1.1' })} />)
    expect(screen.getByRole('link', { name: 'From chat: Release 1.1' })).toHaveAttribute('href', '/c/c1')
  })

  it('names an untitled chat, and shows nothing for a job started elsewhere', () => {
    const { container, rerender } = show(<FromChat job={codeJob({ conversation_id: 'c1', conversation_title: null })} />)
    expect(screen.getByRole('link')).toHaveTextContent('From chat: Untitled')
    rerender(wrap(<FromChat job={codeJob()} />))
    expect(container).toBeEmptyDOMElement()
  })
})
