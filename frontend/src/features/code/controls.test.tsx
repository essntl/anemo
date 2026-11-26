import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import { codeJob } from './testJobs'

type Callbacks = { onSuccess?: (v: unknown) => void; onError?: (e: unknown) => void }
const cancelJob = vi.fn()
const followUp = vi.fn()
/** The images of each follow-up sent (by the box or by the queue), as ids. */
const sentImages: string[][] = []
let fail: unknown = null
vi.mock('./api', async (importOriginal) => ({
  startErrorMessage: (await importOriginal<typeof import('./api')>()).startErrorMessage,
  useCancelJob: () => ({ isPending: false, mutate: (id: string, cb: Callbacks) => { cancelJob(id); if (fail) cb.onError?.(fail); else cb.onSuccess?.({}) } }),
  useFollowUp: (jobId: string) => ({
    isPending: false,
    mutate: ({ prompt, images = [] }: { prompt: string; images?: { id: string }[] }, cb: Callbacks) => {
      followUp(jobId, prompt)
      sentImages.push(images.map((i) => i.id))
      if (fail) cb.onError?.(fail)
      else cb.onSuccess?.({})
    },
  }),
  // Messages for a running job (§15): the thread's, and sending, removing, sending now.
  isWaiting: (await importOriginal<typeof import('./api')>()).isWaiting,
  useThreadMessages: () => messages,
  useSendMessage: (jobId: string) => ({
    isPending: false,
    mutate: ({ prompt, images = [], now = false }: { prompt: string; images?: { id: string }[]; now?: boolean }, cb: Callbacks) => {
      sendMessage(jobId, prompt, now)
      sentImages.push(images.map((i) => i.id))
      if (fail) cb.onError?.(fail)
      else cb.onSuccess?.({})
    },
  }),
  useRemoveMessage: () => ({ isPending: false, variables: null, mutate: (id: string, cb: Callbacks) => { removeMessage(id); if (fail) cb.onError?.(fail); else cb.onSuccess?.(undefined) } }),
  useSendMessageNow: () => ({ isPending: false, variables: null, mutate: (id: string, cb: Callbacks) => { sendNow(id); if (fail) cb.onError?.(fail); else cb.onSuccess?.({}) } }),
}))
const sendMessage = vi.fn()
const removeMessage = vi.fn()
const sendNow = vi.fn()
type Message = import('./api').CodeMessage
let messages: Message[] = []
const msg = (more: Partial<Message> = {}): Message => ({
  id: 'm1', thread_id: 't1', job_id: 'r1', prompt: 'Then run the tests', images: [], mode: 'queue', state: 'sent', note: null,
  created_at: '2026-11-26T10:00:00Z', sent_at: null, delivered_at: null, delivered_seq: null, follow_up_job_id: null, ...more,
})
const toasts = vi.hoisted(() => [] as string[])
const undo = vi.hoisted(() => [] as (() => void)[])
vi.mock('@/components/ui/toast', () => ({ toast: (o: { message: string; action?: { onClick: () => void } }) => { toasts.push(o.message); if (o.action) undo.push(o.action.onClick) } }))
const confirm = vi.fn()
vi.mock('@/components/ui/dialogs', () => ({ confirmDialog: (...a: unknown[]) => confirm(...a) }))

// An image upload (the chat's POST /api/attachments): answered with an id, or held until `release`.
const uploads = vi.hoisted(() => ({ n: 0, hold: false, waiting: [] as (() => void)[] }))
vi.mock('@/features/chat/useAttachments', () => ({
  uploadAttachment: (file: File) => new Promise((resolve) => {
    uploads.n += 1
    const done = () => resolve({ id: `att-${uploads.n}`, filename: file.name, mime: file.type, size: file.size, kind: 'image', extraction_note: null })
    if (uploads.hold) uploads.waiting.push(done)
    else done()
  }),
}))
const png = (name: string, size = 100) => new File([new Uint8Array(size)], name, { type: 'image/png' })

// `coarse`: a touch screen (the only media query the follow-up box asks).
const media = vi.hoisted(() => ({ coarse: false }))
vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: () => media.coarse }))

const { CancelJobButton, FollowUpBox, FromChat } = await import('./controls')
const { useCodeQueue } = await import('./queueStore')

const device = (more: object = {}) => ({ id: 'dev-1', name: 'Desk PC', online: true, last_seen_at: null, share: true, start: true, cancel: true, ...more })
const client = new QueryClient()
const wrap = (ui: ReactNode) => <QueryClientProvider client={client}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>
const show = (ui: ReactNode) => render(wrap(ui))

beforeEach(() => {
  vi.clearAllMocks()
  toasts.length = 0
  fail = null
  media.coarse = false
  localStorage.clear()
  useCodeQueue.setState({ byThread: {}, drafts: {}, draftImages: {} })
  messages = []
  sentImages.length = 0
  uploads.n = 0
  uploads.hold = false
  uploads.waiting.length = 0
  URL.createObjectURL = vi.fn(() => 'blob:preview')
  URL.revokeObjectURL = vi.fn()
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
    messages = [msg({ prompt: 'Do this instead' })]
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

  it('sends with Enter, as the chat does; Shift+Enter starts a new line', async () => {
    show(<FollowUpBox job={ended()} />)
    const box = screen.getByRole('textbox', { name: 'Follow-up' })
    await userEvent.type(box, 'Line one{Shift>}{Enter}{/Shift}line two')
    expect(followUp).not.toHaveBeenCalled()
    await userEvent.keyboard('{Enter}')
    expect(followUp).toHaveBeenCalledWith('j9', 'Line one\nline two')
  })

  it('sends with Ctrl+Enter too', async () => {
    show(<FollowUpBox job={ended()} />)
    await userEvent.type(screen.getByRole('textbox', { name: 'Follow-up' }), 'More')
    await userEvent.keyboard('{Control>}{Enter}{/Control}')
    expect(followUp).toHaveBeenCalledWith('j9', 'More')
  })

  it('on a touch screen Enter adds a line and the button sends', async () => {
    media.coarse = true
    show(<FollowUpBox job={ended()} />)
    await userEvent.type(screen.getByRole('textbox', { name: 'Follow-up' }), 'Line one{Enter}line two')
    expect(followUp).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(followUp).toHaveBeenCalledWith('j9', 'Line one\nline two')
  })

  it('is one line with the button beside the text, not under it', () => {
    show(<FollowUpBox job={ended()} />)
    const box = screen.getByRole('textbox', { name: 'Follow-up' })
    expect(box).toHaveAttribute('rows', '1')
    expect(box).toHaveAttribute('placeholder', 'Ask for more in the same session…')
    expect(screen.getByRole('button', { name: 'Send' }).parentElement).toBe(box.parentElement)
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

describe('Messages while the job runs (§15)', () => {
  const running = (more = {}) => codeJob({ id: 'r1', thread_id: 't1', state: 'running', session_id: 'sess-1', ...more })

  it('queues a message for the running job and clears the box', async () => {
    show(<FollowUpBox job={running()} />)
    const box = screen.getByRole('textbox', { name: 'Message for this job' })
    expect(screen.getByRole('button', { name: 'Queue message' })).toBeDisabled()
    await userEvent.type(box, 'Then run the tests')
    await userEvent.click(screen.getByRole('button', { name: 'Queue message' }))
    expect(followUp).not.toHaveBeenCalled()
    expect(sendMessage).toHaveBeenCalledWith('r1', 'Then run the tests', false)
    expect(box).toHaveValue('')
  })

  it('Send now sends it at once, interrupting the current step', async () => {
    show(<FollowUpBox job={running()} />)
    await userEvent.type(screen.getByRole('textbox'), 'Stop, do this first')
    await userEvent.click(screen.getByRole('button', { name: 'Send now' }))
    expect(sendMessage).toHaveBeenCalledWith('r1', 'Stop, do this first', true)
  })

  it('Enter queues (as the chat sends); Send now needs a computer that lets Anemo stop the job', async () => {
    show(<FollowUpBox job={running({ device: device({ cancel: false }) })} />)
    await userEvent.type(screen.getByRole('textbox'), 'One')
    await userEvent.keyboard('{Control>}{Enter}{/Control}')
    expect(sendMessage).toHaveBeenCalledWith('r1', 'One', false)
    expect(screen.queryByRole('button', { name: 'Send now' })).not.toBeInTheDocument()
  })

  it('keeps the text and says why when the server refuses', async () => {
    fail = new ApiError(409, 'device_busy', 'Desk PC is busy.')
    show(<FollowUpBox job={running()} />)
    await userEvent.type(screen.getByRole('textbox'), 'Later')
    await userEvent.click(screen.getByRole('button', { name: 'Queue message' }))
    expect(screen.getByRole('textbox')).toHaveValue('Later')
    expect(toasts).toEqual(['Desk PC is busy.'])
  })

  it('shows each waiting message with where it is', () => {
    messages = [
      msg({ id: 'a', state: 'sent', prompt: 'In Claude Code’s hands' }),
      msg({ id: 'b', state: 'queued', note: 'This job can’t take messages while it runs: sent as a follow-up when it ends.', prompt: 'Waits' }),
      msg({ id: 'c', state: 'sent', mode: 'now', prompt: 'Urgent' }),
      msg({ id: 'd', state: 'delivered', prompt: 'Taken in already' }),
    ]
    show(<FollowUpBox job={running()} />)
    const cards = screen.getAllByTestId('queued-message')
    expect(cards).toHaveLength(3) // a delivered one is in the timeline, not here
    expect(cards[0]).toHaveTextContent('Queued: Claude Code takes it in after its current step')
    expect(cards[1]).toHaveTextContent('sent as a follow-up when it ends')
    expect(cards[2]).toHaveTextContent('Sending now: Claude Code stops its current step…')
  })

  it('Edit takes the message back into the box; Remove drops it', async () => {
    messages = [msg({ prompt: 'Draft' })]
    show(<FollowUpBox job={running()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(removeMessage).toHaveBeenCalledWith('m1')
    expect(screen.getByRole('textbox')).toHaveValue('Draft')
    // Kept as the thread's draft: leaving the thread doesn't lose it.
    expect(useCodeQueue.getState().drafts.t1).toBe('Draft')
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(removeMessage).toHaveBeenCalledTimes(2)
    expect(toasts).toEqual(['Queued message removed'])
  })

  it('a message Claude Code took in meanwhile can’t be taken back: the box stays as it was', async () => {
    fail = new ApiError(409, 'message_delivered', 'Claude Code took this message in already.')
    messages = [msg({ prompt: 'Too late' })]
    show(<FollowUpBox job={running()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByRole('textbox')).toHaveValue('')
    expect(toasts).toEqual(['Claude Code took this message in already.'])
  })

  it('a queued message can be sent now', async () => {
    messages = [msg({ state: 'queued' })]
    show(<FollowUpBox job={running()} />)
    const card = screen.getByTestId('queued-message')
    await userEvent.click(within(card).getByRole('button', { name: 'Send now' }))
    expect(sendNow).toHaveBeenCalledWith('m1')
  })

  it('a held message says why, and Send now sends it as a follow-up', async () => {
    messages = [msg({ state: 'held', note: 'The job didn’t finish, so this message wasn’t sent.' })]
    show(<FollowUpBox job={running({ id: 'r2', state: 'failed' })} />)
    const card = screen.getByTestId('queued-message')
    expect(card).toHaveTextContent('The job didn’t finish, so this message wasn’t sent.')
    await userEvent.click(within(card).getByRole('button', { name: 'Send now' }))
    expect(sendNow).toHaveBeenCalledWith('m1')
  })

  it('a held message can’t be sent where follow-ups can’t: it can still be edited or discarded', async () => {
    messages = [msg({ state: 'held', note: 'Waiting.' })]
    show(<FollowUpBox job={running({ state: 'done', device: device({ online: false }) })} />)
    expect(screen.queryByRole('button', { name: 'Send now' })).not.toBeInTheDocument()
    expect(screen.getByTestId('follow-up-off')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Discard message' }))
    expect(removeMessage).toHaveBeenCalledWith('m1')
    expect(toasts).toEqual(['Message discarded'])
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

describe('Images in the follow-up box', () => {
  const ended = () => codeJob({ id: 'j9', thread_id: 't1', state: 'done', session_id: 'sess-1' })
  const running = () => codeJob({ id: 'r1', thread_id: 't1', state: 'running', session_id: 'sess-1' })
  const pick = (...files: File[]) => userEvent.upload(screen.getByTestId('code-image-input'), files)

  it('picks images, shows them, and sends them with the follow-up', async () => {
    show(<FollowUpBox job={ended()} />)
    await pick(png('shot.png'), png('second.png'))
    expect(await screen.findByText('shot.png')).toBeInTheDocument()
    expect(screen.getByText('second.png')).toBeInTheDocument()
    // Kept with the thread's draft (by id), like the text.
    expect(useCodeQueue.getState().draftImages?.t1?.map((i) => i.id)).toEqual(['att-1', 'att-2'])
    await userEvent.type(screen.getByRole('textbox'), 'Make it look like this')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(followUp).toHaveBeenCalledWith('j9', 'Make it look like this')
    expect(sentImages).toEqual([['att-1', 'att-2']])
    // The box is empty again.
    expect(screen.queryByTestId('code-images')).not.toBeInTheDocument()
    expect(useCodeQueue.getState().draftImages?.t1).toBeUndefined()
  })

  it('takes a pasted image and a dropped one, and removes one before sending', async () => {
    show(<FollowUpBox job={ended()} />)
    const box = screen.getByRole('textbox')
    fireEvent.paste(box, { clipboardData: { files: [png('image.png')], items: [] } })
    // Uploaded: from then on in the thread's draft, its chip named as pastes are.
    await waitFor(() => expect(useCodeQueue.getState().draftImages?.t1).toHaveLength(1))
    expect(screen.getByText(/^Pasted image .*\.png$/)).toBeInTheDocument()
    const form = box.closest('form')!
    fireEvent.drop(form, { dataTransfer: { files: [png('dropped.png')], types: ['Files'] } })
    await waitFor(() => expect(useCodeQueue.getState().draftImages?.t1).toHaveLength(2))
    expect(screen.getByText('dropped.png')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Remove dropped.png' }))
    await userEvent.type(box, 'Look')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(sentImages).toEqual([['att-1']])
  })

  it('refuses what isn’t a PNG, JPEG, WebP or GIF, too large, or too many, and says why', async () => {
    show(<FollowUpBox job={ended()} />)
    await userEvent.upload(screen.getByTestId('code-image-input'), new File(['x'], 'notes.txt', { type: 'text/plain' }), { applyAccept: false })
    expect(toasts.at(-1)).toBe('“notes.txt” isn’t a PNG, JPEG, WebP or GIF image.')
    await pick(png('huge.png', 10 * 1024 * 1024 + 1))
    expect(toasts.at(-1)).toBe('“huge.png” is larger than 10.0 MB.')
    await pick(...Array.from({ length: 9 }, (_, i) => png(`${i}.png`)))
    expect(toasts.at(-1)).toBe('At most 8 images can go with one message.')
    expect(useCodeQueue.getState().draftImages?.t1).toHaveLength(8)
    expect(screen.getByRole('button', { name: 'Add images' })).toBeDisabled()
  })

  it('waits for an upload before it sends', async () => {
    uploads.hold = true
    show(<FollowUpBox job={ended()} />)
    await pick(png('slow.png'))
    await userEvent.type(screen.getByRole('textbox'), 'Look')
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    expect(screen.getByText('Uploading…')).toBeInTheDocument()
    await act(async () => uploads.waiting.forEach((done) => done()))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled())
  })

  it('sends images with a message for the running job, and Edit puts them back in the box', async () => {
    show(<FollowUpBox job={running()} />)
    await pick(png('shot.png'))
    await screen.findByText('shot.png')
    await userEvent.type(screen.getByRole('textbox'), 'Then this')
    await userEvent.click(screen.getByRole('button', { name: 'Queue message' }))
    expect(sendMessage).toHaveBeenCalledWith('r1', 'Then this', false)
    expect(sentImages).toEqual([['att-1']])
    expect(screen.queryByTestId('code-images')).not.toBeInTheDocument()
  })

  it('a waiting message shows its images; Edit puts them back as the draft', async () => {
    messages = [msg({ prompt: 'Like this', images: [{ id: 'att-7', name: 'a.png' }] })]
    show(<FollowUpBox job={running()} />)
    const card = screen.getByTestId('queued-message')
    expect(card.querySelector('img')).toHaveAttribute('src', '/api/attachments/att-7/content')
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(removeMessage).toHaveBeenCalledWith('m1')
    expect(useCodeQueue.getState().draftImages?.t1?.map((i) => i.id)).toEqual(['att-7'])
    expect(screen.getByRole('textbox')).toHaveValue('Like this')
  })
})
