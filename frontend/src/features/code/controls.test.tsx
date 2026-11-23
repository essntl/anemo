import type { ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import { codeJob } from './testJobs'

type Callbacks = { onSuccess?: (v: unknown) => void; onError?: (e: unknown) => void }
const cancelJob = vi.fn()
const followUp = vi.fn()
let fail: unknown = null
vi.mock('./api', () => ({
  useCancelJob: () => ({ isPending: false, mutate: (id: string, cb: Callbacks) => { cancelJob(id); if (fail) cb.onError?.(fail); else cb.onSuccess?.({}) } }),
  useFollowUp: (jobId: string) => ({ isPending: false, mutate: (prompt: string, cb: Callbacks) => { followUp(jobId, prompt); if (fail) cb.onError?.(fail); else cb.onSuccess?.({}) } }),
}))
const toasts = vi.hoisted(() => [] as string[])
vi.mock('@/components/ui/toast', () => ({ toast: (o: { message: string }) => toasts.push(o.message) }))
const confirm = vi.fn()
vi.mock('@/components/ui/dialogs', () => ({ confirmDialog: (...a: unknown[]) => confirm(...a) }))

const { CancelJobButton, FollowUpBox, FromChat } = await import('./controls')

const device = (more: object = {}) => ({ id: 'dev-1', name: 'Desk PC', online: true, last_seen_at: null, share: true, start: true, cancel: true, ...more })
const show = (ui: ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>)

beforeEach(() => {
  vi.clearAllMocks()
  toasts.length = 0
  fail = null
})

describe('Cancel', () => {
  it('asks first, then cancels the running job', async () => {
    confirm.mockResolvedValue(true)
    show(<CancelJobButton job={codeJob({ id: 'r1', state: 'running' })} />)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel job' }))
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Cancel this job?', danger: true }))
    expect(cancelJob).toHaveBeenCalledWith('r1')
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
    rerender(<MemoryRouter><CancelJobButton job={codeJob({ state: 'running', device: device({ cancel: false }) })} /></MemoryRouter>)
    expect(screen.queryByRole('button', { name: 'Cancel job' })).not.toBeInTheDocument()
  })

  it('needs cancel, not start: a paused computer can still cancel', () => {
    show(<CancelJobButton job={codeJob({ state: 'running', device: device({ start: false, cancel: true }) })} />)
    expect(screen.getByRole('button', { name: 'Cancel job' })).toBeInTheDocument()
  })
})

describe('Follow-up', () => {
  const ended = (more = {}) => codeJob({ id: 'j9', state: 'done', session_id: 'sess-9', ...more })

  it('sends with the button and clears the box', async () => {
    show(<FollowUpBox job={ended()} />)
    const box = screen.getByRole('textbox', { name: 'Follow-up' })
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    await userEvent.type(box, '  Now the changelog  ')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(followUp).toHaveBeenCalledWith('j9', 'Now the changelog')
    expect(box).toHaveValue('')
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

  it('is hidden while the job runs or when there is no session', () => {
    const { container, rerender } = show(<FollowUpBox job={ended({ state: 'running' })} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<MemoryRouter><FollowUpBox job={ended({ session_id: null })} /></MemoryRouter>)
    expect(container).toBeEmptyDOMElement()
  })

  it('says why when the computer is offline or doesn’t allow starting', () => {
    const { rerender } = show(<FollowUpBox job={ended({ device: device({ online: false, start: false }) })} />)
    expect(screen.getByTestId('follow-up-off')).toHaveTextContent('Desk PC is offline: a follow-up can be sent once it is back.')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    rerender(<MemoryRouter><FollowUpBox job={ended({ device: device({ start: false }) })} /></MemoryRouter>)
    expect(screen.getByTestId('follow-up-off')).toHaveTextContent(/doesn’t let Anemo start Claude Code jobs/)
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
    rerender(<MemoryRouter><FromChat job={codeJob()} /></MemoryRouter>)
    expect(container).toBeEmptyDOMElement()
  })
})
