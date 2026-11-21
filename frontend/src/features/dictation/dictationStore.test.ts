import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import { useToasts } from '@/components/ui/toast'
import { dictation, MIN_RECORDING_MS, useDictation } from './dictationStore'

const mocks = vi.hoisted(() => ({
  startRecording: vi.fn(),
  transcribe: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
}))
vi.mock('./recorder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./recorder')>()),
  startRecording: mocks.startRecording,
}))
vi.mock('./api', () => ({ transcribe: mocks.transcribe }))

const said = (text: string) => ({ text, raw: text, cleaned: true, warning: null })

async function record(into?: HTMLElement | null) {
  await dictation.start(into as HTMLTextAreaElement | null | undefined)
  expect(useDictation.getState().phase).toBe('recording')
  vi.advanceTimersByTime(MIN_RECORDING_MS + 100)
}

function lastToast(): string | undefined {
  return useToasts.getState().toasts.at(-1)?.message
}

beforeEach(() => {
  vi.useFakeTimers()
  mocks.stop.mockResolvedValue(new Blob(['audio'], { type: 'audio/webm' }))
  mocks.startRecording.mockResolvedValue({ stop: mocks.stop, cancel: mocks.cancel, level: () => 0.5 })
  mocks.transcribe.mockResolvedValue(said('Add milk to the list.'))
})

afterEach(() => {
  dictation.cancel()
  dictation.setOpenPage(null)
  dictation.takePendingText()
  useToasts.setState({ toasts: [] })
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('dictation', () => {
  it('puts the text into the message box it was started in, as a chat message', async () => {
    document.body.innerHTML = '<textarea data-dictation="chat"></textarea>'
    const box = document.querySelector('textarea')!
    await record(box)
    await dictation.finish()
    expect(mocks.transcribe).toHaveBeenCalledWith(expect.any(Blob), 'chat', expect.any(AbortSignal))
    expect(box.value).toBe('Add milk to the list.')
    expect(useDictation.getState().phase).toBe('idle')
  })

  it('uses the text field that has the focus, tidied as text', async () => {
    document.body.innerHTML = '<textarea data-dictation="chat"></textarea><input id="title" />'
    const title = document.getElementById('title') as HTMLInputElement
    title.focus()
    await record()
    await dictation.finish()
    expect(mocks.transcribe).toHaveBeenCalledWith(expect.any(Blob), 'text', expect.any(AbortSignal))
    expect(title.value).toBe('Add milk to the list.')
  })

  it('falls back to the message box on screen when no field had the focus', async () => {
    document.body.innerHTML = '<textarea></textarea>'
    const box = document.querySelector('textarea')!
    const remove = dictation.addMessageBox(box)
    await record()
    await dictation.finish()
    expect(box.value).toBe('Add milk to the list.')
    remove()
  })

  it('opens a new chat with the text when there is no text box at all', async () => {
    const openPage = vi.fn()
    dictation.setOpenPage(openPage)
    await record()
    await dictation.finish()
    expect(openPage).toHaveBeenCalledWith('/')
    expect(dictation.takePendingText()).toBe('Add milk to the list.')
    expect(dictation.takePendingText()).toBeNull()
  })

  it('throws a recording away when cancelled', async () => {
    await record()
    dictation.cancel()
    expect(mocks.cancel).toHaveBeenCalled()
    expect(useDictation.getState().phase).toBe('idle')
    await dictation.finish()
    expect(mocks.transcribe).not.toHaveBeenCalled()
  })

  it('ignores a slip of the finger', async () => {
    await dictation.start()
    vi.advanceTimersByTime(100)
    await dictation.finish()
    expect(mocks.transcribe).not.toHaveBeenCalled()
    expect(lastToast()).toBe('Nothing was recorded.')
  })

  it('toggles: start, then finish; never two at once', async () => {
    dictation.toggle()
    await vi.waitFor(() => expect(useDictation.getState().phase).toBe('recording'))
    await dictation.start()
    expect(mocks.startRecording).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(MIN_RECORDING_MS + 100)
    dictation.toggle()
    await vi.waitFor(() => expect(mocks.transcribe).toHaveBeenCalledTimes(1))
  })

  it('stops by itself after ten minutes', async () => {
    await record()
    vi.advanceTimersByTime(10 * 60 * 1000)
    await vi.waitFor(() => expect(mocks.transcribe).toHaveBeenCalledTimes(1))
  })

  it('says where to choose a model when there is none', async () => {
    const openPage = vi.fn()
    dictation.setOpenPage(openPage)
    mocks.transcribe.mockRejectedValue(new ApiError(409, 'no_transcription_model', 'No speech-to-text model yet'))
    await record()
    await dictation.finish()
    const shown = useToasts.getState().toasts.at(-1)
    expect(shown?.message).toMatch(/speech-to-text model/)
    shown?.action?.onClick()
    expect(openPage).toHaveBeenCalledWith('/settings/providers')
  })

  it('explains a microphone the browser refused', async () => {
    const { RecorderError } = await import('./recorder')
    mocks.startRecording.mockRejectedValue(new RecorderError('denied', 'NotAllowedError'))
    await dictation.start()
    expect(useDictation.getState().phase).toBe('idle')
    expect(lastToast()).toMatch(/didn’t allow the microphone/)
  })

  it('says when nothing was heard, and when the text could not be tidied', async () => {
    document.body.innerHTML = '<textarea></textarea>'
    const box = document.querySelector('textarea')!
    mocks.transcribe.mockResolvedValueOnce(said(''))
    await record(box)
    await dictation.finish()
    expect(lastToast()).toMatch(/Didn’t catch anything/)
    mocks.transcribe.mockResolvedValueOnce({ text: 'uh hi', raw: 'uh hi', cleaned: false, warning: 'x' })
    await record(box)
    await dictation.finish()
    expect(box.value).toBe('uh hi')
    expect(lastToast()).toMatch(/as it was heard/)
  })
})
