import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const add = vi.fn()
const rename = vi.fn()
const setTrust = vi.fn()
const remove = vi.fn()
const devices = [
  {
    id: 'd1', name: 'Agent VM', kind: 'computer', trust: 'trusted', created_at: '2026-11-01T10:00:00Z',
    last_seen_at: '2026-11-22T10:00:00Z', client_version: '1.0.0', online: true, control: true, shell: true,
  },
  {
    id: 'd2', name: 'Desk PC', kind: 'computer', trust: 'watched', created_at: '2026-11-01T10:00:00Z',
    last_seen_at: null, client_version: null, online: false, control: false, shell: false,
  },
  {
    id: 'd3', name: 'Pixel', kind: 'phone', trust: 'watched', created_at: '2026-11-01T10:00:00Z',
    last_seen_at: '2026-11-22T10:00:00Z', client_version: '1.0.0', online: true, control: false, shell: false,
  },
]
vi.mock('./api', () => ({
  useDevices: () => ({ data: devices, isError: false }),
  useAddDevice: () => ({
    isPending: false,
    isError: false,
    mutate: (body: { name: string; kind: string; trust: string }, opts: { onSuccess: (d: unknown) => void }) => {
      add(body)
      opts.onSuccess({ ...body, id: 'new', token: 'anemo_secret-value' })
    },
  }),
  useRenameDevice: () => ({ mutate: rename }),
  useSetTrust: () => ({ mutate: setTrust, isPending: false }),
  useDeleteDevice: () => ({ mutate: remove }),
}))
// The file size card has its own test (DeviceFilesCard.test.tsx).
vi.mock('./DeviceFilesCard', () => ({ DeviceFilesCard: () => null }))
vi.mock('./DeviceCodeCard', () => ({ DeviceCodeCard: () => null }))
const toastMessages = vi.hoisted(() => [] as string[])
vi.mock('@/components/ui/toast', () => ({ toast: (o: { message: string }) => toastMessages.push(o.message) }))
const confirm = vi.fn()
const prompt = vi.fn()
vi.mock('@/components/ui/dialogs', () => ({
  confirmDialog: (...a: unknown[]) => confirm(...a),
  promptDialog: (...a: unknown[]) => prompt(...a),
}))

const { DevicesSettingsPage } = await import('./DevicesSettingsPage')

// The trust menu (Radix Select) scrolls to the chosen option, which jsdom can't do.
Element.prototype.scrollIntoView ??= () => {}

const row = (name: string) => screen.getAllByTestId('device-row').find((r) => r.textContent?.includes(name))!

describe('Settings → Devices', () => {
  beforeEach(() => vi.clearAllMocks())

  it('lists devices with whether they are online, never a token', () => {
    render(<DevicesSettingsPage />)
    expect(within(row('Agent VM')).getByText('Online')).toBeInTheDocument()
    expect(within(row('Desk PC')).getByText('Offline')).toBeInTheDocument()
    expect(within(row('Desk PC')).getByText(/never connected/)).toBeInTheDocument()
    // Phones have no trust level to choose.
    expect(within(row('Pixel')).queryByRole('combobox')).not.toBeInTheDocument()
    expect(within(row('Desk PC')).getByRole('combobox', { name: 'Trust of “Desk PC”' })).toBeInTheDocument()
    expect(screen.queryByText(/anemo_/)).not.toBeInTheDocument()
  })

  it('adds a device and shows its token once, until Done', async () => {
    render(<DevicesSettingsPage />)
    await userEvent.type(screen.getByLabelText('Name'), 'Laptop')
    await userEvent.click(screen.getByRole('button', { name: 'Add device' }))
    expect(add).toHaveBeenCalledWith({ name: 'Laptop', kind: 'computer', trust: 'watched' })
    expect(screen.getByTestId('new-device-token')).toHaveTextContent('anemo_secret-value')
    expect(screen.getByText(/Anemo Desktop on that computer/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByTestId('new-device-token')).not.toBeInTheDocument()
  })

  it('adds a phone without a trust level', async () => {
    render(<DevicesSettingsPage />)
    await userEvent.click(screen.getByRole('radio', { name: 'Phone' }))
    expect(screen.queryByRole('radio', { name: 'Trusted' })).not.toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Name'), 'Pixel 9')
    await userEvent.click(screen.getByRole('button', { name: 'Add device' }))
    expect(add).toHaveBeenCalledWith({ name: 'Pixel 9', kind: 'phone', trust: 'watched' })
    expect(screen.getByText(/Anemo Voice on that phone/)).toBeInTheDocument()
  })

  it('renames, and deletes only after confirming', async () => {
    render(<DevicesSettingsPage />)
    prompt.mockResolvedValueOnce('  Desk ')
    await userEvent.click(within(row('Desk PC')).getByRole('button', { name: 'Rename' }))
    expect(rename).toHaveBeenCalledWith({ id: 'd2', name: 'Desk' }, expect.anything())

    confirm.mockResolvedValueOnce(false)
    await userEvent.click(within(row('Desk PC')).getByRole('button', { name: 'Delete' }))
    expect(remove).not.toHaveBeenCalled()
    confirm.mockResolvedValueOnce(true)
    await userEvent.click(within(row('Desk PC')).getByRole('button', { name: 'Delete' }))
    expect(remove).toHaveBeenCalledWith('d2', expect.anything())
  })

  it('changes the trust level through its menu', async () => {
    render(<DevicesSettingsPage />)
    within(row('Desk PC')).getByRole('combobox', { name: 'Trust of “Desk PC”' }).focus()
    await userEvent.keyboard('{Enter}')
    await userEvent.click(await screen.findByRole('option', { name: 'Trusted' }))
    expect(setTrust).toHaveBeenCalledWith({ id: 'd2', trust: 'trusted' }, expect.anything())
  })

  it('says so when the token cannot be copied', async () => {
    render(<DevicesSettingsPage />)
    await userEvent.type(screen.getByLabelText('Name'), 'Laptop')
    await userEvent.click(screen.getByRole('button', { name: 'Add device' }))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } })
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(toastMessages).toContain('The token could not be copied. Select it and copy it yourself.')
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
  })
})
