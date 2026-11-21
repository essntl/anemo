import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dictation } from '@/features/dictation/dictationStore'
import { Composer } from './Composer'

// The hook returns the skills themselves (an array), not a query.
vi.mock('@/features/profiles/api', () => ({ useSlashSkills: () => [] }))
// `coarse`: a touch screen (the only media query the box asks).
const media = vi.hoisted(() => ({ coarse: false }))
vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: () => media.coarse }))

function renderComposer(onSend: (text: string) => void | Promise<unknown>) {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Composer running={false} onSend={onSend} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('the message box', () => {
  it('is cleared when the message is sent', async () => {
    const onSend = vi.fn(() => Promise.resolve())
    renderComposer(onSend)
    const box = screen.getByRole('textbox')
    await userEvent.type(box, 'Hello there{Enter}')
    expect(onSend).toHaveBeenCalledWith('Hello there', [], [], null)
    expect(box).toHaveValue('')
  })

  it('gets the message back when sending fails', async () => {
    let fail!: (err: Error) => void
    renderComposer(() => new Promise((_, reject) => { fail = reject }))
    const box = screen.getByRole('textbox')
    await userEvent.type(box, 'Please keep this{Enter}')
    expect(box).toHaveValue('')
    fail(new Error('offline'))
    await vi.waitFor(() => expect(box).toHaveValue('Please keep this'))
  })

  it("doesn't overwrite what was typed after a failed send", async () => {
    let fail!: (err: Error) => void
    renderComposer(() => new Promise((_, reject) => { fail = reject }))
    const box = screen.getByRole('textbox')
    await userEvent.type(box, 'First{Enter}')
    await userEvent.type(box, 'Second')
    fail(new Error('offline'))
    await new Promise((r) => setTimeout(r, 0))
    expect(box).toHaveValue('Second')
  })
})

describe('pasting an image on a phone', () => {
  const png = () => new File(['x'], 'image.png', { type: 'image/png' })

  function stubUploads() {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const f = (init.body as FormData).get('file') as File
      return new Response(JSON.stringify({ id: crypto.randomUUID(), filename: f.name, mime: f.type, size: f.size, kind: 'image', extraction_note: null }), { status: 201 })
    }))
  }

  afterEach(() => {
    media.coarse = false
    vi.unstubAllGlobals()
  })

  it('attaches an image Chrome on Android hands to the box as an input, not a paste', async () => {
    stubUploads()
    renderComposer(() => undefined)
    const box = screen.getByRole('textbox')
    const event = new InputEvent('beforeinput', { inputType: 'insertFromPaste', bubbles: true, cancelable: true })
    const image = png()
    Object.defineProperty(event, 'dataTransfer', { value: { files: [], items: [{ kind: 'file', getAsFile: () => image }] } })
    fireEvent(box, event)
    expect(event.defaultPrevented).toBe(true)
    expect(await screen.findByText(/^Pasted image .*\.png$/)).toBeInTheDocument()
    expect(box).toHaveValue('')
  })

  it('leaves a text paste alone', () => {
    renderComposer(() => undefined)
    const event = new InputEvent('beforeinput', { inputType: 'insertFromPaste', data: 'hello', bubbles: true, cancelable: true })
    fireEvent(screen.getByRole('textbox'), event)
    expect(event.defaultPrevented).toBe(false)
  })

  it('reads an image from the clipboard with "Paste an image" on a touch screen', async () => {
    media.coarse = true
    stubUploads()
    const blob = new Blob(['x'], { type: 'image/png' })
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), {
      clipboard: { read: async () => [{ types: ['image/png'], getType: async () => blob }] },
    }))
    renderComposer(() => undefined)
    await userEvent.click(screen.getByRole('button', { name: 'Add to the message' }))
    await userEvent.click(await screen.findByRole('button', { name: /Paste an image/ }))
    expect(await screen.findByText(/^Pasted image .*\.png$/)).toBeInTheDocument()
  })

  it('dictates into its own box with the microphone button', async () => {
    const start = vi.spyOn(dictation, 'start').mockResolvedValue()
    renderComposer(() => undefined)
    await userEvent.click(screen.getByRole('button', { name: 'Dictate' }))
    expect(start).toHaveBeenCalledWith(screen.getByRole('textbox'))
    start.mockRestore()
  })

  it('is where dictated text goes when a new chat was opened for it', () => {
    vi.spyOn(dictation, 'takePendingText').mockReturnValueOnce('Plan my week')
    renderComposer(() => undefined)
    expect(screen.getByRole('textbox')).toHaveValue('Plan my week')
  })
})
