import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mutate = vi.fn()
const profiles = [
  { id: 'p-scoped', name: 'Scoped', preset: 'scoped', categories: { see: 'allow', act: 'ask', shell: 'folders', files: 'folders', code: 'ask' }, relevance_check: true, devices: 1, description: '' },
  { id: 'p-watched', name: 'Watched', preset: 'watched', categories: { see: 'policy', act: 'ask', shell: 'deny', files: 'deny', code: 'deny' }, relevance_check: false, devices: 0, description: '' },
]
const permissions = {
  device_id: 'd1',
  profile: profiles[0],
  work_folders: [
    { path: 'C:\\dev', recycle: false, added_from: 'settings' },
    { path: 'C:\\Users\\a\\Downloads', recycle: true, added_from: 'approval:2026-11-27T10:00:00Z' },
  ],
  protected: [
    { key: 'anemo', label: 'x', paths: [], default: 'hard', level: 'hard', adjustable: false },
    { key: 'keys', label: 'x', paths: [], default: 'deny', level: 'deny', adjustable: true },
  ],
  automations_unrestricted: false,
  version: 3,
  grants: [],
}
vi.mock('./api', () => ({
  useDevicePermissions: () => ({ data: permissions, isError: false }),
  useDeviceProfiles: () => ({ data: profiles }),
  useSetPermissions: () => ({ mutate, isPending: false }),
}))

const { DevicePermissionsPanel } = await import('./DevicePermissions')
Element.prototype.scrollIntoView ??= () => {}

describe('Settings → Devices → Permissions', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows the profile, its levels, the work folders and the protected folders', () => {
    render(<DevicePermissionsPanel deviceId="d1" deviceName="Main PC" />)
    expect(screen.getByRole('combobox', { name: 'Profile of “Main PC”' })).toHaveTextContent('Scoped')
    expect(screen.getAllByText('By work folders')).toHaveLength(2)
    const folders = screen.getAllByTestId('work-folder')
    expect(folders.map((f) => f.querySelector('code')?.textContent)).toEqual(['C:\\dev', 'C:\\Users\\a\\Downloads'])
    expect(within(folders[1]).getByText(/added from an approval on/)).toBeInTheDocument()
    expect(screen.getByText('Always refused')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Level for SSH, AWS and GnuPG keys' })).toHaveTextContent('Refused')
  })

  it('adds and removes work folders, then saves them together', async () => {
    render(<DevicePermissionsPanel deviceId="d1" deviceName="Main PC" />)
    const save = screen.getByRole('button', { name: 'Save folders' })
    expect(save).toBeDisabled()
    await userEvent.type(screen.getByLabelText('New work folder'), 'D:\\notes')
    await userEvent.click(screen.getByRole('button', { name: 'Add' }))
    await userEvent.click(screen.getByRole('button', { name: 'Remove C:\\dev' }))
    await userEvent.click(save)
    expect(mutate).toHaveBeenCalledWith({
      id: 'd1',
      change: {
        work_folders: [
          { path: 'C:\\Users\\a\\Downloads', recycle: true, added_from: 'approval:2026-11-27T10:00:00Z' },
          { path: 'D:\\notes', recycle: true, added_from: 'settings' },
        ],
      },
    }, expect.anything())
  })

  it('switches the automation switch at once', async () => {
    render(<DevicePermissionsPanel deviceId="d1" deviceName="Main PC" />)
    await userEvent.click(screen.getByRole('switch', { name: 'Unrestricted for automations' }))
    expect(mutate).toHaveBeenCalledWith({ id: 'd1', change: { automations_unrestricted: true } }, expect.anything())
  })
})
