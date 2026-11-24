import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import type { CodeDevice, CodeProjects, StartJobInput } from './api'

let devices: CodeDevice[] = []
let projects: Record<string, CodeProjects> = {}
const askedProjects: (string | null)[] = []
const started: StartJobInput[] = []
let fail: unknown = null
vi.mock('./api', async (importOriginal) => ({
  startErrorMessage: (await importOriginal<typeof import('./api')>()).startErrorMessage,
  useCodeDevices: () => ({ data: devices, isSuccess: true, isPending: false, isError: false }),
  useCodeProjects: (id: string | null) => {
    askedProjects.push(id)
    const data = id ? projects[id] : undefined
    return { data, isSuccess: Boolean(data), isFetching: false, isError: false }
  },
  useStartJob: () => ({
    isPending: false,
    mutate: (body: StartJobInput, cb: { onSuccess?: (job: { id: string }) => void; onError?: (e: unknown) => void }) => {
      started.push(body)
      if (fail) cb.onError?.(fail)
      else cb.onSuccess?.({ id: 'new-job' })
    },
  }),
}))
const toasts = vi.hoisted(() => [] as string[])
vi.mock('@/components/ui/toast', () => ({ toast: (o: { message: string }) => toasts.push(o.message) }))
// An image upload (POST /api/attachments): answered with the next id.
const uploads = vi.hoisted(() => ({ n: 0 }))
vi.mock('@/features/chat/useAttachments', () => ({
  uploadAttachment: async (file: File) => ({ id: `att-${++uploads.n}`, filename: file.name, mime: file.type, size: file.size, kind: 'image', extraction_note: null }),
}))

const { NewJobDialog } = await import('./NewJobDialog')
const { clearNewJobDraft } = await import('./newJobDraft')

// Radix Select scrolls to the chosen option, which jsdom can't do.
Element.prototype.scrollIntoView ??= () => {}

const close = vi.fn()
function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>
}
function show() {
  return render(
    <MemoryRouter initialEntries={['/code']}>
      <Routes><Route path="*" element={<><NewJobDialog open onOpenChange={close} /><Where /></>} /></Routes>
    </MemoryRouter>,
  )
}

const pc = (id: string, name: string, more: Partial<CodeDevice> = {}): CodeDevice =>
  ({ id, name, online: true, last_seen_at: null, share: true, start: true, cancel: true, ...more }) as CodeDevice

beforeEach(() => {
  vi.clearAllMocks()
  clearNewJobDraft()
  uploads.n = 0
  URL.createObjectURL = vi.fn(() => 'blob:preview')
  URL.revokeObjectURL = vi.fn()
  toasts.length = 0
  started.length = 0
  askedProjects.length = 0
  fail = null
  devices = [pc('d0', 'Watched PC', { start: false }), pc('d1', 'Desk PC'), pc('d2', 'Laptop'), pc('d3', 'Away PC', { online: false, start: false })]
  projects = {
    d1: { projects: [{ name: 'anemo', dir: 'C:\\dev\\anemo', remote: 'https://github.com/essntl/anemo' }], remote: [{ name: 'site', url: 'https://github.com/essntl/site' }], note: null },
    d2: { projects: [], remote: [], note: 'gh isn’t installed on this computer.' },
  }
})

const dialog = () => screen.getByRole('dialog')
const projectBox = () => within(dialog()).getByRole('combobox', { name: /^Project/ })

describe('New job', () => {
  it('offers only computers that let Anemo start jobs, and asks the chosen one for its projects', async () => {
    show()
    const computer = within(dialog()).getByRole('combobox', { name: 'Computer' })
    expect(computer).toHaveTextContent('Desk PC')
    expect(askedProjects.at(-1)).toBe('d1')
    computer.focus()
    await userEvent.keyboard('{Enter}')
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent)
    expect(options).toEqual(['Desk PC', 'Laptop'])
    await userEvent.click(screen.getByRole('option', { name: 'Laptop' }))
    expect(askedProjects.at(-1)).toBe('d2')
    // Why the repositories aren't listed.
    expect(within(dialog()).getByText('gh isn’t installed on this computer.')).toBeInTheDocument()
  })

  it('lists local projects first, then the repositories not cloned', async () => {
    show()
    await userEvent.click(projectBox())
    const options = within(screen.getByRole('listbox', { name: 'Projects' })).getAllByRole('option').map((o) => o.textContent)
    expect(options).toEqual(['anemoC:\\dev\\anemo', 'site'])
    expect(screen.getByText('On this computer')).toBeInTheDocument()
    expect(screen.getByText('On GitHub, not cloned')).toBeInTheDocument()
  })

  it('lets the list scroll by wheel and touch, though the dialog locks scrolling outside it', async () => {
    show()
    await userEvent.click(projectBox())
    const option = within(screen.getByRole('listbox', { name: 'Projects' })).getAllByRole('option')[1]
    const wheel = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true })
    option.dispatchEvent(wheel)
    expect(wheel.defaultPrevented).toBe(false)
    const touch = new Event('touchmove', { bubbles: true, cancelable: true })
    option.dispatchEvent(touch)
    expect(touch.defaultPrevented).toBe(false)
  })

  it('narrows the list by what is typed, and takes a project by click or by arrows and Enter', async () => {
    show()
    await userEvent.type(projectBox(), 'si')
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['site'])
    await userEvent.click(screen.getByRole('option', { name: 'site' }))
    expect(projectBox()).toHaveValue('site')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    // Picked, not typed: the whole list is back.
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getAllByRole('option')).toHaveLength(2)
    expect(projectBox()).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[0].id)
    await userEvent.keyboard('{Enter}')
    expect(projectBox()).toHaveValue('anemo')
    expect(started).toEqual([])
  })

  it('opens with the focus in the project field (list closed), and keeps what was typed when closed and opened again', async () => {
    const { unmount } = show()
    await waitFor(() => expect(projectBox()).toHaveFocus())
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    await userEvent.type(projectBox(), 'anemo')
    await userEvent.type(within(dialog()).getByRole('textbox', { name: 'Prompt' }), 'Half a prompt')
    unmount()
    show()
    expect(projectBox()).toHaveValue('anemo')
    expect(within(dialog()).getByRole('textbox', { name: 'Prompt' })).toHaveValue('Half a prompt')
  })

  it('Enter takes the first match of what is typed', async () => {
    show()
    await userEvent.type(projectBox(), 'ane{Enter}')
    expect(projectBox()).toHaveValue('anemo')
    expect(started).toEqual([])
  })

  it('Escape closes the list, not the dialog; a name that matches nothing shows no list', async () => {
    show()
    await userEvent.click(projectBox())
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(dialog()).toBeInTheDocument()
    await userEvent.type(projectBox(), 'zzz')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('starts a job in a known project with a model, then opens it', async () => {
    show()
    expect(within(dialog()).getByRole('button', { name: 'Start job' })).toBeDisabled()
    await userEvent.type(projectBox(), 'anemo')
    // A known project: nothing to create.
    expect(within(dialog()).queryByRole('switch', { name: 'New project' })).not.toBeInTheDocument()
    await userEvent.type(within(dialog()).getByRole('textbox', { name: 'Prompt' }), 'Bump the version')
    within(dialog()).getByRole('combobox', { name: 'Model' }).focus()
    await userEvent.keyboard('{Enter}')
    await userEvent.click(await screen.findByRole('option', { name: 'Sonnet' }))
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Start job' }))
    expect(started).toEqual([{ device_id: 'd1', project: 'anemo', prompt: 'Bump the version', new: false, model: 'sonnet' }])
    expect(close).toHaveBeenCalledWith(false)
    expect(screen.getByTestId('where')).toHaveTextContent('/code/new-job')
  })

  it('starts a job with images: picked, shown, sent by id, and gone from the draft after', async () => {
    show()
    await userEvent.type(projectBox(), 'anemo')
    await userEvent.type(within(dialog()).getByRole('textbox', { name: 'Prompt' }), 'Make it look like this')
    const shot = new File([new Uint8Array(50)], 'mockup.png', { type: 'image/png' })
    await userEvent.upload(within(dialog()).getByTestId('code-image-input'), shot)
    await waitFor(() => expect(within(dialog()).getByTestId('code-images').querySelector('img')).toHaveAttribute('src', '/api/attachments/att-1/content'))
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Start job' }))
    expect(started).toEqual([{ device_id: 'd1', project: 'anemo', prompt: 'Make it look like this', new: false, model: null, image_ids: ['att-1'] }])
    const { newJobDraft } = await import('./newJobDraft')
    expect(newJobDraft.images).toEqual([])
  })

  it('offers "New project" for a name that is nowhere, and sends the default model as null', async () => {
    show()
    await userEvent.type(projectBox(), 'brand-new')
    const toggle = within(dialog()).getByRole('switch', { name: 'New project' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    await userEvent.click(toggle)
    await userEvent.type(within(dialog()).getByRole('textbox', { name: 'Prompt' }), 'Start it')
    await userEvent.keyboard('{Control>}{Enter}{/Control}')
    expect(started).toEqual([{ device_id: 'd1', project: 'brand-new', prompt: 'Start it', new: true, model: null }])
  })

  it('takes a repository that isn’t cloned yet without "New project"', async () => {
    show()
    await userEvent.type(projectBox(), 'Site')
    expect(within(dialog()).queryByRole('switch', { name: 'New project' })).not.toBeInTheDocument()
  })

  it('refuses a name that is a path', async () => {
    show()
    await userEvent.type(projectBox(), '..\\secrets')
    await userEvent.type(within(dialog()).getByRole('textbox', { name: 'Prompt' }), 'x')
    expect(within(dialog()).getByText(/^A folder name: letters, digits/)).toBeInTheDocument()
    expect(within(dialog()).getByRole('button', { name: 'Start job' })).toBeDisabled()
  })

  it('refuses a Windows device name and a name ending with a dot, as the computer does', async () => {
    show()
    await userEvent.type(within(dialog()).getByRole('textbox', { name: 'Prompt' }), 'x')
    for (const name of ['nul.txt', 'COM3', 'site.', '...']) {
      await userEvent.clear(projectBox())
      await userEvent.type(projectBox(), name)
      expect(within(dialog()).getByText(/^A folder name: letters, digits/)).toBeInTheDocument()
      expect(within(dialog()).getByRole('button', { name: 'Start job' })).toBeDisabled()
      expect(within(dialog()).queryByRole('switch', { name: 'New project' })).not.toBeInTheDocument()
    }
  })

  it('doesn’t offer "New project" for a name a local folder is a clone of', async () => {
    projects.d1.projects.push({ name: 'anemo-main', dir: 'C:\\dev\\anemo-main', remote: 'https://github.com/essntl/anemo-core.git' })
    show()
    await userEvent.type(projectBox(), 'anemo-core')
    expect(within(dialog()).queryByRole('switch', { name: 'New project' })).not.toBeInTheDocument()
  })

  it('shows the server’s message when starting fails, and stays open', async () => {
    fail = new ApiError(422, 'device_failed', 'There is no project "x" in C:\\dev or on GitHub (essntl).')
    show()
    await userEvent.type(projectBox(), 'anemo')
    await userEvent.type(within(dialog()).getByRole('textbox', { name: 'Prompt' }), 'Go')
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Start job' }))
    expect(toasts).toEqual(['There is no project "x" in C:\\dev or on GitHub (essntl).'])
    expect(close).not.toHaveBeenCalled()
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/code$/)
  })

  it('keeps a picked computer that stops being usable, says why, and starts nothing', async () => {
    const { rerender } = show()
    const computer = () => within(dialog()).getByRole('combobox', { name: 'Computer' })
    computer().focus()
    await userEvent.keyboard('{Enter}')
    await userEvent.click(await screen.findByRole('option', { name: 'Laptop' }))
    await userEvent.type(projectBox(), 'anemo')
    await userEvent.type(within(dialog()).getByRole('textbox', { name: 'Prompt' }), 'Go')
    expect(within(dialog()).getByRole('button', { name: 'Start job' })).toBeEnabled()

    // A code.job notice refetched the computers: the laptop is paused now.
    devices = devices.map((d) => (d.id === 'd2' ? { ...d, start: false } : d))
    rerender(<MemoryRouter initialEntries={['/code']}><Routes><Route path="*" element={<><NewJobDialog open onOpenChange={close} /><Where /></>} /></Routes></MemoryRouter>)
    expect(computer()).toHaveTextContent('Laptop')
    expect(within(dialog()).getByText('Laptop doesn’t let Anemo start jobs right now.')).toBeInTheDocument()
    expect(within(dialog()).getByRole('button', { name: 'Start job' })).toBeDisabled()

    // Offline, then gone from the list altogether: still the laptop, never Desk PC.
    devices = devices.map((d) => (d.id === 'd2' ? { ...d, online: false } : d))
    rerender(<MemoryRouter initialEntries={['/code']}><Routes><Route path="*" element={<><NewJobDialog open onOpenChange={close} /><Where /></>} /></Routes></MemoryRouter>)
    expect(within(dialog()).getByText('Laptop is offline now.')).toBeInTheDocument()
    devices = devices.filter((d) => d.id !== 'd2')
    rerender(<MemoryRouter initialEntries={['/code']}><Routes><Route path="*" element={<><NewJobDialog open onOpenChange={close} /><Where /></>} /></Routes></MemoryRouter>)
    expect(computer()).toHaveTextContent('Laptop')
    expect(within(dialog()).getByText('Laptop is no longer one of your trusted computers.')).toBeInTheDocument()
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Start job' }))
    expect(started).toEqual([])
  })

  it('follows the first usable computer while none has been picked', () => {
    const { rerender } = show()
    expect(within(dialog()).getByRole('combobox', { name: 'Computer' })).toHaveTextContent('Desk PC')
    devices = devices.filter((d) => d.id !== 'd1')
    rerender(<MemoryRouter initialEntries={['/code']}><Routes><Route path="*" element={<><NewJobDialog open onOpenChange={close} /><Where /></>} /></Routes></MemoryRouter>)
    expect(within(dialog()).getByRole('combobox', { name: 'Computer' })).toHaveTextContent('Laptop')
  })

  it('sends the prompt as typed, and refuses a blank one', async () => {
    show()
    await userEvent.type(projectBox(), 'anemo')
    const prompt = within(dialog()).getByRole('textbox', { name: 'Prompt' })
    await userEvent.type(prompt, '  {Enter}  ')
    expect(within(dialog()).getByRole('button', { name: 'Start job' })).toBeDisabled()
    await userEvent.type(prompt, '- keep the indent{Enter}')
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Start job' }))
    expect(started[0].prompt).toBe('  \n  - keep the indent\n')
  })

  it('says the job may have started when no answer came, and doesn’t open anything', async () => {
    fail = new ApiError(504, 'http_504', 'Gateway Timeout')
    show()
    await userEvent.type(projectBox(), 'anemo')
    await userEvent.type(within(dialog()).getByRole('textbox', { name: 'Prompt' }), 'Go')
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Start job' }))
    expect(toasts).toEqual(['No answer came in time: the job may have started anyway. The list is being refreshed.'])
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/code$/)
    expect(close).not.toHaveBeenCalled()
  })

  it('shows the server’s message when the computer is busy', async () => {
    fail = new ApiError(409, 'device_busy', 'Desk PC is busy with another command.')
    show()
    await userEvent.type(projectBox(), 'anemo')
    await userEvent.type(within(dialog()).getByRole('textbox', { name: 'Prompt' }), 'Go')
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Start job' }))
    expect(toasts).toEqual(['Desk PC is busy with another command.'])
  })

  it('says how to allow starting when no computer does', () => {
    devices = [pc('d0', 'Watched PC', { start: false })]
    show()
    expect(screen.getByTestId('no-start-device')).toHaveTextContent('Let Anemo start Claude Code jobs')
    expect(within(dialog()).getByRole('button', { name: 'Start job' })).toBeDisabled()
  })
})
